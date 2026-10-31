// Receives Stripe events and keeps memberships in sync. Stripe calls this directly (no user sign-in),
// so every event is checked against the webhook signing secret saved by stripe-setup.
import { addDays, admin, cryptoProvider, getSecret, stripe, today } from '../_shared/util.ts';
import type Stripe from 'npm:stripe@17.7.0';

Deno.serve(async (req) => {
  const db = admin();
  const s = stripe();
  const secret = await getSecret(db, 'stripe_webhook_secret');
  if (!secret) return new Response('Webhook secret missing: run stripe-setup', { status: 500 });

  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature') ?? '', secret, undefined, cryptoProvider);
  } catch (e) {
    return new Response(`Bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const findMember = async (memberId?: string | null, customer?: string | null) => {
    if (memberId) {
      const { data } = await db.from('profiles').select('*').eq('id', memberId).maybeSingle();
      if (data) return data;
    }
    if (customer) {
      const { data } = await db.from('profiles').select('*').eq('stripe_customer_id', customer).maybeSingle();
      if (data) return data;
    }
    return null;
  };
  const planForPrice = async (priceId?: string) => {
    if (!priceId) return null;
    const { data } = await db.from('plans').select('*').eq('stripe_price_id', priceId).maybeSingle();
    return data;
  };
  const notify = (member_id: string, body: string) => db.from('notifications').insert({ member_id, body });
  const log = (body: string) => db.from('activity_log').insert({ body });
  const recordPayment = (member_id: string | null, amount: number, description: string, obj: string, status: string) =>
    db.from('payments').upsert({ member_id, amount_pence: amount, description, stripe_object: obj, status }, { onConflict: 'stripe_object' });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const cs = event.data.object as Stripe.Checkout.Session;
        const m = await findMember(cs.metadata?.member_id, cs.customer as string);
        if (!m) break;
        const { data: plan } = await db.from('plans').select('*').eq('id', cs.metadata?.plan_id ?? '').single();
        if (!plan) break;
        if (cs.mode === 'payment') {
          // Bacs payments can complete later; only add credits once paid
          if (cs.payment_status !== 'paid') break;
          const sameLivePack = m.plan_id === plan.id && m.credits_expire && m.credits_expire >= today();
          await db.from('profiles').update({
            plan_id: plan.id,
            status: 'active',
            credits: (sameLivePack ? m.credits : 0) + (plan.pack ?? 1),
            credits_expire: addDays(today(), plan.valid_days ?? 30),
            plan_started: today(),
          }).eq('id', m.id);
          await recordPayment(m.id, cs.amount_total ?? plan.price_pence, plan.name, cs.id, 'paid');
          await notify(m.id, `Payment received: ${plan.name}. You can book now.`);
        } else {
          await db.from('profiles').update({
            plan_id: plan.id,
            status: 'active',
            stripe_subscription_id: cs.subscription as string,
            plan_started: today(),
            frozen_until: null,
          }).eq('id', m.id);
          await notify(m.id, `Welcome to ${plan.name}. You can book classes now.`);
        }
        await log(`${m.first_name} ${m.last_name} joined ${plan.name}`);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const m = await findMember(sub.metadata?.member_id, sub.customer as string);
        if (!m) break;
        const plan = (await planForPrice(sub.items.data[0]?.price?.id)) ?? null;
        let status = m.status as string;
        if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled') status = 'cancelled';
        else if (sub.pause_collection) status = 'frozen';
        else if (['past_due', 'unpaid'].includes(sub.status)) status = 'past_due';
        else if (['active', 'trialing'].includes(sub.status)) status = m.status === 'frozen' && m.frozen_until && m.frozen_until >= today() ? 'frozen' : 'active';
        const update: Record<string, unknown> = { status, stripe_subscription_id: status === 'cancelled' ? null : sub.id };
        // keep 'intro' as the plan label during the intro month even though it bills at the Unlimited price
        if (plan && !(m.plan_id === 'intro' && plan.id === 'intro')) update.plan_id = plan.id;
        await db.from('profiles').update(update).eq('id', m.id);
        if (status === 'cancelled') {
          await notify(m.id, 'Your membership has ended. We\'d love to see you back any time.');
          await log(`${m.first_name} ${m.last_name}'s membership ended`);
        }
        break;
      }

      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        const m = await findMember(null, inv.customer as string);
        const line = inv.lines?.data?.[0];
        await recordPayment(m?.id ?? null, inv.amount_paid, line?.description ?? 'Membership', inv.id!, 'paid');
        if (m && m.status === 'past_due') await db.from('profiles').update({ status: 'active' }).eq('id', m.id);
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const m = await findMember(null, inv.customer as string);
        if (!m) break;
        await db.from('profiles').update({ status: 'past_due' }).eq('id', m.id);
        await recordPayment(m.id, inv.amount_due, 'Payment failed', `${inv.id}-failed`, 'failed');
        await notify(m.id, 'Your membership payment didn\'t go through. Please update your payment details in Me > Membership.');
        await log(`Payment failed for ${m.first_name} ${m.last_name}`);
        break;
      }
    }
  } catch (e) {
    // returning 500 makes Stripe retry later
    return new Response(`Handler error: ${(e as Error).message}`, { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
});
