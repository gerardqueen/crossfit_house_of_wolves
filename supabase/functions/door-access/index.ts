// Door access.
//   token      (member)  -> short-lived signed QR code for the door scanner
//   verify     (scanner) -> checks a scanned QR code; header x-door-key must match the scanner key
//   open       (member)  -> "Open door" button in the app (same rules as the QR code)
//   staff-open (staff)   -> open the door from the coach screen
//   configure  (owner)   -> save the unlock provider and its settings
//   device-key (owner)   -> show the scanner key to paste into door.html
//   test       (owner)   -> fire the unlock without any checks
// Rules (booked_only / active_members / off) live in the database function door_check().
import { admin, caller, cors, fail, getSecret, hmac, json, readBody, setSecret } from '../_shared/util.ts';
import { unlock } from './unlock.ts';

const TOKEN_SECONDS = 60;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = admin();
  try {
    const body = await readBody(req) as Record<string, string>;
    const action = body.action ?? new URL(req.url).searchParams.get('action') ?? '';

    if (action === 'verify') {
      const deviceKey = await getSecret(db, 'door_device_key');
      if (!deviceKey || req.headers.get('x-door-key') !== deviceKey) return fail('Scanner not authorised', 403);
      const secret = await getSecret(db, 'door_token_secret');
      const parts = String(body.token ?? '').split('.');
      if (parts.length !== 4 || parts[0] !== 'HOW1' || !secret) return json({ allowed: false, reason: 'Not a House of Wolves pass' });
      const [, memberId, exp, sig] = parts;
      if (Number(exp) < Math.floor(Date.now() / 1000)) return json({ allowed: false, reason: 'Pass expired. Refresh it in the app.' });
      if ((await hmac(secret, `${memberId}.${exp}`)) !== sig) return json({ allowed: false, reason: 'Invalid pass' });
      return await decide(db, memberId);
    }

    const me = await caller(req);
    if (!me) return fail('Please sign in', 401);
    const staff = me.role === 'coach' || me.role === 'owner';

    switch (action) {
      case 'token': {
        const secret = await getSecret(db, 'door_token_secret');
        if (!secret) return fail('Door access is not set up yet');
        const exp = Math.floor(Date.now() / 1000) + TOKEN_SECONDS;
        return json({ token: `HOW1.${me.id}.${exp}.${await hmac(secret, `${me.id}.${exp}`)}`, expires_in: TOKEN_SECONDS });
      }
      case 'open':
        return await decide(db, me.id);
      case 'staff-open': {
        if (!staff) return fail('Staff only', 403);
        await db.from('access_log').insert({ member_id: me.id, allowed: true, reason: 'Opened by staff', method: 'staff' });
        const res = await unlock(db, { member: `${me.first_name} ${me.last_name}`, reason: 'Opened by staff' });
        return json({ allowed: true, reason: 'Opened by staff', unlock: res });
      }
      case 'configure': {
        if (me.role !== 'owner') return fail('Owner only', 403);
        const provider = body.provider ?? 'none';
        if (!['none', 'webhook', 'shelly_cloud'].includes(provider)) return fail('Unknown provider');
        await db.from('settings').update({ door_provider: provider, ...(body.door_mode ? { door_mode: body.door_mode } : {}) }).eq('id', 1);
        for (const k of ['door_webhook_url', 'shelly_server', 'shelly_auth_key', 'shelly_device_id', 'shelly_channel']) {
          if (typeof body[k] === 'string' && body[k] !== '') await setSecret(db, k, body[k]);
        }
        if (provider === 'webhook' && !(await getSecret(db, 'door_webhook_secret'))) {
          await setSecret(db, 'door_webhook_secret', crypto.randomUUID().replace(/-/g, ''));
        }
        return json({ ok: true, webhook_secret: provider === 'webhook' ? await getSecret(db, 'door_webhook_secret') : undefined });
      }
      case 'device-key': {
        if (me.role !== 'owner') return fail('Owner only', 403);
        return json({ device_key: await getSecret(db, 'door_device_key') });
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

async function decide(db: ReturnType<typeof admin>, memberId: string) {
  const { data, error } = await db.rpc('door_check', { p_member: memberId });
  if (error) return fail(error.message, 500);
  const r = (data as { allowed: boolean; reason: string; display_name: string }[])[0];
  if (!r?.allowed) return json({ allowed: false, reason: r?.reason ?? 'Not allowed', name: r?.display_name ?? '' });
  const res = await unlock(db, { member: r.display_name, reason: r.reason });
  return json({ allowed: true, reason: r.reason, name: r.display_name, unlock: res });
}
