// Door plug-in adapters: one function that "buzzes" the door, whichever device the gym uses.
// Pick one in Coach > Settings > Door buzzer.
//   none          Logs only (for testing the rules before the plug-in is fitted).
//   shelly_cloud  A Shelly relay wired to the door release, through the Shelly Cloud API.
//                 Set the relay's auto-off timer (e.g. 5 s) in the Shelly app so the door locks again by itself.
//   switchbot     A SwitchBot Bot pressing the existing buzzer/release button, through the SwitchBot API.
//   webhook       POSTs a signed message to any URL: Home Assistant, Node-RED, IFTTT/Zapier/Make, or a
//                 door system with webhooks. Use this for Tuya/Smart Life and other smart plugs via Home Assistant.
// To add another device, add a case below that calls its API and returns { ok, detail }.
import { getSecret, hmac } from '../_shared/util.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const PROVIDERS = ['none', 'shelly_cloud', 'switchbot', 'webhook'];
export type UnlockResult = { ok: boolean; provider: string; detail?: string };

export async function unlock(db: SupabaseClient, info: { member: string; reason: string }): Promise<UnlockResult> {
  const { data: s } = await db.from('settings').select('door_provider').eq('id', 1).single();
  const provider = (s?.door_provider as string) ?? 'none';
  const timeout = AbortSignal.timeout(6000);
  try {
    switch (provider) {
      case 'shelly_cloud': {
        const server = (await getSecret(db, 'shelly_server'))?.replace(/\/$/, '');
        const key = await getSecret(db, 'shelly_auth_key');
        const id = await getSecret(db, 'shelly_device_id');
        const channel = (await getSecret(db, 'shelly_channel')) ?? '0';
        if (!server || !key || !id) return { ok: false, provider, detail: 'Shelly settings incomplete' };
        const form = new URLSearchParams({ id, auth_key: key, channel, turn: 'on' });
        const r = await fetch(`${server}/device/relay/control`, { method: 'POST', body: form, signal: timeout });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok && j.isok !== false, provider, detail: j.errors ? JSON.stringify(j.errors) : `HTTP ${r.status}` };
      }
      case 'switchbot': {
        const token = await getSecret(db, 'switchbot_token');
        const secret = await getSecret(db, 'switchbot_secret');
        const device = await getSecret(db, 'switchbot_device_id');
        if (!token || !secret || !device) return { ok: false, provider, detail: 'SwitchBot settings incomplete' };
        const t = String(Date.now()), nonce = crypto.randomUUID();
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token + t + nonce)));
        const sign = btoa(String.fromCharCode(...raw)).toUpperCase();
        const r = await fetch(`https://api.switch-bot.com/v1.1/devices/${encodeURIComponent(device)}/commands`, {
          method: 'POST',
          headers: { Authorization: token, sign, t, nonce, 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'press', parameter: 'default', commandType: 'command' }),
          signal: timeout,
        });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok && (j.statusCode === undefined || j.statusCode === 100), provider, detail: j.message ?? `HTTP ${r.status}` };
      }
      case 'webhook': {
        const url = await getSecret(db, 'door_webhook_url');
        const secret = (await getSecret(db, 'door_webhook_secret')) ?? '';
        if (!url) return { ok: false, provider, detail: 'No webhook URL saved' };
        const payload = JSON.stringify({ event: 'buzz', member: info.member, reason: info.reason, at: new Date().toISOString() });
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HOW-Signature': await hmac(secret, payload) },
          body: payload,
          signal: timeout,
        });
        return { ok: r.ok, provider, detail: `HTTP ${r.status}` };
      }
      default:
        return { ok: true, provider: 'none', detail: 'Logged only (no plug-in set)' };
    }
  } catch (e) {
    return { ok: false, provider, detail: (e as Error).message };
  }
}
