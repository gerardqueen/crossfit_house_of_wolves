// One-click Stripe setup. Run once by the owner after adding STRIPE_SECRET_KEY.
// Creates products and prices for every plan, the intro coupon, the customer portal and the webhook endpoint,
// and generates the door secrets. Safe to run again (e.g. after a price change): it reuses what already exists.
import { admin, caller, cors, fail, json, randomKey, getSecret, setSecret, stripe } from '../_shared/util.ts';

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const me = await caller(req);
    if (!me || me.role !== 'owner') return fail('Owner only', 403);
    const s = stripe();
    const db = admin();
    const report: string[] = [];

    // 1. products + prices
    const { data: plans, error } = await db.from('plans').select('*').eq('active', true).order('sort');
    if (error) throw error;
    for (const p of plans ?? []) {
      let productId = p.stripe_product_id as string | null;
      if (productId) {
        try { await s.products.update(productId, { name: p.name, description: p.description || undefined, active: true }); }
        catch { productId = null; }
      }
      if (!productId) {
        const prod = await s.products.create({ name: p.name, description: p.description || undefined, metadata: { plan_id: p.id } });
        productId = prod.id;
      }
      const lookup = `how_${p.id}_${p.price_pence}`;
      const found = await s.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
      let priceId = found.data[0]?.id;
      if (!priceId) {
        const price = await s.prices.create({
          product: productId,
          currency: 'gbp',
          unit_amount: p.price_pence,
          lookup_key: lookup,
          transfer_lookup_key: true,
          ...(p.monthly ? { recurring: { interval: 'month' } } : {}),
          metadata: { plan_id: p.id },
        });
        priceId = price.id;
        report.push(`Created price for ${p.name}: £${(p.price_pence / 100).toFixed(2)}${p.monthly ? '/month' : ''}`);
      }
      await db.from('plans').update({ stripe_product_id: productId, stripe_price_id: priceId }).eq('id', p.id);
    }

    // 2. intro coupon (£ off the first month)
    const intro = (plans ?? []).find((p) => p.intro_discount_pence > 0);
    if (intro) {
      const couponId = `how-intro-${intro.intro_discount_pence}`;
      try { await s.coupons.retrieve(couponId); }
      catch {
        await s.coupons.create({ id: couponId, amount_off: intro.intro_discount_pence, currency: 'gbp', duration: 'once', name: 'Introductory month' });
        report.push(`Created intro coupon: £${(intro.intro_discount_pence / 100).toFixed(2)} off the first month`);
      }
    }

    // 3. customer portal (update card, see invoices, cancel at period end)
    const configs = await s.billingPortal.configurations.list({ is_default: true, limit: 1 });
    if (!configs.data.length) {
      await s.billingPortal.configurations.create({
        business_profile: { headline: 'Manage your House of Wolves membership' },
        features: {
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
        },
      });
      report.push('Created customer portal settings');
    }

    // 4. webhook endpoint pointing at this project's stripe-webhook function
    const hookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/stripe-webhook`;
    const existing = (await s.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === hookUrl);
    const haveSecret = await getSecret(db, 'stripe_webhook_secret');
    if (existing && haveSecret) {
      await s.webhookEndpoints.update(existing.id, { enabled_events: [...WEBHOOK_EVENTS] });
    } else {
      if (existing) await s.webhookEndpoints.del(existing.id);
      const hook = await s.webhookEndpoints.create({ url: hookUrl, enabled_events: [...WEBHOOK_EVENTS], description: 'House of Wolves app' });
      await setSecret(db, 'stripe_webhook_secret', hook.secret!);
      report.push('Created Stripe webhook and stored its signing secret');
    }

    // 5. door secrets
    if (!(await getSecret(db, 'door_token_secret'))) { await setSecret(db, 'door_token_secret', randomKey()); report.push('Generated door QR signing key'); }
    if (!(await getSecret(db, 'door_device_key'))) { await setSecret(db, 'door_device_key', randomKey(24)); report.push('Generated door scanner key'); }

    // 6. remember where the app lives (for Stripe return links)
    const origin = req.headers.get('origin');
    if (origin) await db.from('settings').update({ app_url: origin }).eq('id', 1).is('app_url', null);

    const mode = Deno.env.get('STRIPE_SECRET_KEY')!.startsWith('sk_live') ? 'live' : 'test';
    return json({ ok: true, mode, report: report.length ? report : ['Everything was already set up'] });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
