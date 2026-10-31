// Data rights for members (UK GDPR): download everything we hold, or delete the account.
//   export -> JSON file of the member's data
//   delete -> cancels any subscription, then deletes the login and all personal data.
//             Payment records are kept (with the member link removed) for accounting.
import { admin, caller, cors, fail, json, readBody, stripe } from '../_shared/util.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const me = await caller(req);
    if (!me) return fail('Please sign in', 401);
    const body = await readBody(req) as { action?: string; confirm?: string };
    const db = admin();

    if (body.action === 'export') {
      const tables = ['bookings', 'og_bookings', 'scores', 'prs', 'consents', 'payments', 'notifications', 'access_log'] as const;
      const out: Record<string, unknown> = { exported_at: new Date().toISOString(), profile: me };
      for (const t of tables) {
        const { data } = await db.from(t).select('*').eq('member_id', me.id);
        out[t] = data ?? [];
      }
      return json(out);
    }

    if (body.action === 'delete') {
      if (body.confirm !== 'DELETE') return fail('Type DELETE to confirm');
      if (me.role === 'owner') return fail('Transfer ownership before deleting the owner account');
      if (me.stripe_subscription_id) {
        try { await stripe().subscriptions.cancel(me.stripe_subscription_id); } catch { /* already gone */ }
      }
      await db.from('activity_log').insert({ body: 'A member deleted their account' });
      const { error } = await db.auth.admin.deleteUser(me.id); // cascades to profile, bookings, scores, etc.
      if (error) return fail(error.message, 500);
      return json({ deleted: true });
    }

    return fail('Unknown action');
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
