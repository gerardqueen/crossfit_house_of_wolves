// Door unlock adapters. Pick one in Coach > Settings > Door access.
//   none          Log only. Use when the door scanner tablet just shows "Welcome" and staff open the door.
//   webhook       POSTs a signed JSON message to any URL. Works with Home Assistant, Node-RED, Zapier/Make,
//                 or an access-control system that accepts webhooks.
//   shelly_cloud  Switches a Shelly relay through the Shelly Cloud API. Set the relay's auto-off timer
//                 (e.g. 5 s) in the Shelly app so the lock re-engages on its own.
// To add another system (Kisi, Salto KS, Paxton Net2 via its API, etc.), add a case below that calls its
// unlock endpoint and returns { ok, detail }.
import { getSecret, hmac } from '../_shared/util.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type UnlockResult = { ok: boolean; provider: string; detail?: string };

export async function unlock(db: SupabaseClient, info: { member: string; reason: string }): Promise<UnlockResult> {
  const { data: s } = await db.from('settings').select('door_provider').eq('id', 1).single();
  const provider = (s?.door_provider as string) ?? 'none';
  try {
    switch (provider) {
      case 'webhook': {
        const url = await getSecret(db, 'door_webhook_url');
        const secret = (await getSecret(db, 'door_webhook_secret')) ?? '';
        if (!url) return { ok: false, provider, detail: 'No webhook URL saved' };
        const payload = JSON.stringify({ event: 'unlock', member: info.member, reason: info.reason, at: new Date().toISOString() });
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-HOW-Signature': await hmac(secret, payload) },
          body: payload,
          signal: AbortSignal.timeout(6000),
        });
        return { ok: r.ok, provider, detail: `HTTP ${r.status}` };
      }
      case 'shelly_cloud': {
        const server = (await getSecret(db, 'shelly_server'))?.replace(/\/$/, '');
        const key = await getSecret(db, 'shelly_auth_key');
        const id = await getSecret(db, 'shelly_device_id');
        const channel = (await getSecret(db, 'shelly_channel')) ?? '0';
        if (!server || !key || !id) return { ok: false, provider, detail: 'Shelly settings incomplete' };
        const form = new URLSearchParams({ id, auth_key: key, channel, turn: 'on' });
        const r = await fetch(`${server}/device/relay/control`, { method: 'POST', body: form, signal: AbortSignal.timeout(6000) });
        return { ok: r.ok, provider, detail: `HTTP ${r.status}` };
      }
      default:
        return { ok: true, provider: 'none', detail: 'Logged only' };
    }
  } catch (e) {
    return { ok: false, provider, detail: (e as Error).message };
  }
}
