// Bring members across from another system (e.g. a StreamFit export).
// Staff send rows of { name, email, phone, plan }. Each person gets an email invite to set their password.
// They start as 'pending' and choose/pay for their plan in the app (existing Direct Debits can't be moved).
import { admin, appUrl, caller, cors, fail, json, readBody } from '../_shared/util.ts';

type Row = { name?: string; email?: string; phone?: string; plan?: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const me = await caller(req);
    if (!me || (me.role !== 'coach' && me.role !== 'owner')) return fail('Staff only', 403);
    const { rows } = await readBody(req) as { rows?: Row[] };
    if (!Array.isArray(rows) || !rows.length) return fail('No rows');
    if (rows.length > 300) return fail('Import up to 300 at a time');
    const db = admin();
    const redirectTo = await appUrl(db, req);
    const { data: plans } = await db.from('plans').select('id,name');
    const results: { email: string; ok: boolean; detail?: string }[] = [];
    for (const r of rows) {
      const email = (r.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { results.push({ email, ok: false, detail: 'Bad email' }); continue; }
      const [first, ...rest] = (r.name ?? '').trim().split(/\s+/);
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
        data: { first_name: first ?? '', last_name: rest.join(' ') },
        redirectTo,
      });
      if (error || !data.user) { results.push({ email, ok: false, detail: error?.message ?? 'Invite failed' }); continue; }
      const plan = (plans ?? []).find((p) => p.id === r.plan || p.name.toLowerCase() === (r.plan ?? '').toLowerCase());
      await db.from('profiles').update({ phone: r.phone ?? '', plan_id: plan?.id ?? null }).eq('id', data.user.id);
      results.push({ email, ok: true });
    }
    await db.from('activity_log').insert({ actor: me.id, body: `Imported ${results.filter((r) => r.ok).length} members` });
    return json({ results });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
