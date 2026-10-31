// Membership self-service: open Stripe's customer portal, freeze (pause billing) and unfreeze.
// Staff can freeze or unfreeze any member by passing member_id.
import { admin, appUrl, asUser, caller, cors, fail, json, readBody, stripe, today } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const me = await caller(req);
    if (!me) return fail('Please sign in', 401);
    const body = await readBody(req) as { action?: string; until?: string; reason?: string; member_id?: string };
    const db = admin();
    const staff = me.role === 'coach' || me.role === 'owner';
    const targetId = staff && body.member_id ? body.member_id : me.id;
    const { data: target } = await db.from('profiles').select('*').eq('id', targetId).single();
    if (!target) return fail('Member not found', 404);

    switch (body.action) {
      case 'portal': {
        if (!target.stripe_customer_id) return fail('No payment account yet');
        const session = await stripe().billingPortal.sessions.create({
          customer: target.stripe_customer_id,
          return_url: `${await appUrl(db, req)}/?tab=me`,
        });
        return json({ url: session.url });
      }

      case 'freeze': {
        const until = String(body.until ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return fail('Pick a date');
        if (targetId === me.id) {
          // runs the freeze rules (7 to 92 days, releases bookings) as the member
          const { error } = await asUser(req).rpc('request_freeze', { p_until: until, p_reason: String(body.reason ?? '') });
          if (error) return fail(error.message);
        } else {
          await db.from('profiles').update({ status: 'frozen', frozen_until: until }).eq('id', targetId);
        }
        if (target.stripe_subscription_id) {
          await stripe().subscriptions.update(target.stripe_subscription_id, {
            pause_collection: { behavior: 'void', resumes_at: Math.floor(new Date(until + 'T06:00:00Z').getTime() / 1000) },
          });
        }
        await db.from('activity_log').insert({ actor: me.id, body: `${target.first_name} ${target.last_name} frozen until ${until}` });
        return json({ ok: true });
      }

      case 'unfreeze': {
        if (target.stripe_subscription_id) {
          await stripe().subscriptions.update(target.stripe_subscription_id, { pause_collection: '' as unknown as null });
        }
        await db.from('profiles').update({ status: 'active', frozen_until: null }).eq('id', targetId);
        await db.from('activity_log').insert({ actor: me.id, body: `${target.first_name} ${target.last_name} unfrozen on ${today()}` });
        return json({ ok: true });
      }

      default:
        return fail('Unknown action');
    }
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
