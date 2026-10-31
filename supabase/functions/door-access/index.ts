// Door buzzer. Members tap "Buzz me in" in the app; this checks they're allowed in right now and near the gym,
// then triggers the door plug-in.
//   buzz       (member) -> rules + location check, then buzz. Body: { lat, lng }
//   staff-buzz (staff)  -> buzz with no checks (e.g. from the front desk)
//   configure  (owner)  -> save the plug-in type, its settings, who can get in, and the gym's location
//   test       (owner)  -> buzz once to test the wiring
// Who can get in (booked_only / active_members / off) is decided by the database function door_check().
import { admin, caller, cors, fail, getSecret, json, readBody, setSecret } from '../_shared/util.ts';
import { PROVIDERS, unlock } from './unlock.ts';

const COOLDOWN_SECONDS = 8;

const metres = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const r = 6371000, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = admin();
  try {
    const body = await readBody(req) as Record<string, string | number | boolean>;
    const me = await caller(req);
    if (!me) return fail('Please sign in', 401);
    const staff = me.role === 'coach' || me.role === 'owner';
    const name = `${me.first_name} ${me.last_name}`.trim();

    switch (body.action) {
      case 'buzz': {
        const { data: st } = await db.from('settings').select('gym_lat,gym_lng,door_radius_m').eq('id', 1).single();
        // location check (skipped until the owner saves the gym's location)
        if (st?.gym_lat != null && st?.gym_lng != null && !staff) {
          const lat = Number(body.lat), lng = Number(body.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ allowed: false, reason: 'Turn on location so we can check you\'re at the gym' });
          const d = metres(lat, lng, st.gym_lat, st.gym_lng);
          const radius = st.door_radius_m ?? 150;
          const slack = Math.min(Number(body.accuracy) || 0, 100); // allow for poor GPS indoors
          if (d > radius + slack) {
            await db.from('access_log').insert({ member_id: me.id, allowed: false, reason: `Too far away (${Math.round(d)} m)`, method: 'app' });
            return json({ allowed: false, reason: `You need to be at the gym to buzz the door (you're about ${d > 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'} away)` });
          }
        }
        // stop repeated taps buzzing over and over
        const since = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
        const { count } = await db.from('access_log').select('id', { count: 'exact', head: true }).eq('member_id', me.id).eq('allowed', true).gte('created_at', since);
        if ((count ?? 0) > 0) return json({ allowed: true, reason: 'Already buzzing', name });
        const { data, error } = await db.rpc('door_check', { p_member: me.id, p_method: 'app' });
        if (error) return fail(error.message, 500);
        const r = (data as { allowed: boolean; reason: string; display_name: string }[])[0];
        if (!r?.allowed) return json({ allowed: false, reason: r?.reason ?? 'Not allowed in right now', name });
        const res = await unlock(db, { member: r.display_name, reason: r.reason });
        if (!res.ok) await db.from('access_log').insert({ member_id: me.id, allowed: false, reason: `Plug-in error: ${res.detail ?? ''}`.slice(0, 200), method: 'app' });
        return json({ allowed: res.ok, reason: res.ok ? r.reason : 'The door didn\'t respond. Please knock or call a coach.', name, unlock: res });
      }
      case 'staff-buzz': {
        if (!staff) return fail('Staff only', 403);
        await db.from('access_log').insert({ member_id: me.id, allowed: true, reason: 'Buzzed by staff', method: 'staff' });
        const res = await unlock(db, { member: name, reason: 'Buzzed by staff' });
        return json({ allowed: res.ok, reason: res.ok ? 'Buzzed by staff' : res.detail, unlock: res });
      }
      case 'configure': {
        if (me.role !== 'owner') return fail('Owner only', 403);
        const provider = String(body.provider ?? 'none');
        if (!PROVIDERS.includes(provider)) return fail('Unknown plug-in type');
        const update: Record<string, unknown> = { door_provider: provider };
        if (['booked_only', 'active_members', 'off'].includes(String(body.door_mode))) update.door_mode = body.door_mode;
        if (body.radius) update.door_radius_m = Math.max(30, Math.min(2000, Number(body.radius) || 150));
        if (body.clear_location) { update.gym_lat = null; update.gym_lng = null; }
        else if (Number.isFinite(Number(body.gym_lat)) && Number.isFinite(Number(body.gym_lng)) && body.gym_lat !== '' && body.gym_lng !== '') {
          update.gym_lat = Number(body.gym_lat); update.gym_lng = Number(body.gym_lng);
        }
        await db.from('settings').update(update).eq('id', 1);
        for (const k of ['door_webhook_url', 'shelly_server', 'shelly_auth_key', 'shelly_device_id', 'shelly_channel', 'switchbot_token', 'switchbot_secret', 'switchbot_device_id']) {
          if (typeof body[k] === 'string' && body[k] !== '') await setSecret(db, k, String(body[k]).trim());
        }
        if (provider === 'webhook' && !(await getSecret(db, 'door_webhook_secret'))) {
          await setSecret(db, 'door_webhook_secret', crypto.randomUUID().replace(/-/g, ''));
        }
        return json({ ok: true, webhook_secret: provider === 'webhook' ? await getSecret(db, 'door_webhook_secret') : undefined });
      }
      case 'test': {
        if (me.role !== 'owner') return fail('Owner only', 403);
        return json({ unlock: await unlock(db, { member: 'Test', reason: 'Test from settings' }) });
      }
      default:
        return fail('Unknown action');
    }
  } catch (e) {
    return fail((e as Error).message, 500);
  }
});
