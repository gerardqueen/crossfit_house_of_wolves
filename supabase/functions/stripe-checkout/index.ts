// Start a payment for a plan. Monthly plans become a Stripe subscription (card or Bacs Direct Debit,
// whichever you switch on in Stripe). Packs and drop-ins are one-off payments.
// If the member already has a live subscription, switching monthly plans updates it in place (prorated).
import { admin, appUrl, caller, cors, fail, json, readBody, stripe } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const me = await caller(req);
    if (!me) return fail('Please sign in', 401);
    const { plan_id } = await readBody(req) as { plan_id?: string };
    const db = admin();
    const { data: plan } = await db.from('plans').select('*').eq('id', plan_id ?? '').eq('active', true).single();
    if (!plan) return fail('Unknown plan');
    if (!plan.stripe_price_id) return fail('Payments are not set up yet. The owner needs to run Stripe setup.');
    if (!me.waiver_signed_at) return fail('Please complete your details and sign the waiver first');
    if (plan.id === 'intro') {
      const { count } = await db.from('payments').select('id', { count: 'exact', head: true }).eq('member_id', me.id);
      if ((count ?? 0) > 0 || me.stripe_subscription_id) return fail('The introductory month is for new members');
    }

    const s = stripe();
    // customer
    let customer = me.stripe_customer_id;
    if (!customer) {
      const c = await s.customers.create({
        email: me.email,
        name: `${me.first_name} ${me.last_name}`.trim(),
        metadata: { member_id: me.id },
      });
      customer = c.id;
      await db.from('profiles').update({ stripe_customer_id: customer }).eq('id', me.id);
    }

    // switch an existing subscription
    if (plan.monthly && me.stripe_subscription_id) {
      const sub = await s.subscriptions.retrieve(me.stripe_subscription_id);
      if (['active', 'trialing', 'past_due'].includes(sub.status)) {
        await s.subscriptions.update(sub.id, {
          items: [{ id: sub.items.data[0].id, price: plan.stripe_price_id }],
          proration_behavior: 'create_prorations',
          metadata: { member_id: me.id, plan_id: plan.id },
        });
        await db.from('profiles').update({ plan_id: plan.id }).eq('id', me.id);
        await db.from('activity_log').insert({ actor: me.id, body: `${me.first_name} ${me.last_name} switched to ${plan.name}` });
        return json({ updated: true });
      }
    }

    const base = await appUrl(db, req);
    const meta = { member_id: me.id, plan_id: plan.id };
    const session = await s.checkout.sessions.create({
      customer,
      mode: plan.monthly ? 'subscription' : 'payment',
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      metadata: meta,
      client_reference_id: me.id,
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancelled`,
      ...(plan.monthly
        ? {
            subscription_data: { metadata: meta },
            ...(plan.intro_discount_pence > 0 ? { discounts: [{ coupon: `how-intro-${plan.intro_discount_pence}` }] } : {}),
          }
        : { payment_intent_data: { metadata: meta } }),
    });
    return json({ url: session.url });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
