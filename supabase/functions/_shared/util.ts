// Shared helpers for the House of Wolves edge functions.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import Stripe from 'npm:stripe@17.7.0';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-door-key',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const fail = (message: string, status = 400) => json({ error: message }, status);

const env = (k: string) => Deno.env.get(k) ?? '';

/** Service-role client: bypasses row level security. Only use after checking who is calling. */
export const admin = (): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

/** Client that acts as the signed-in user (row level security applies). */
export const asUser = (req: Request): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });

export type Profile = {
  id: string; role: 'member' | 'coach' | 'owner'; status: string; first_name: string; last_name: string; email: string;
  plan_id: string | null; credits: number; credits_expire: string | null; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; waiver_signed_at: string | null; frozen_until: string | null;
};

/** Returns the caller's profile, or null if the request isn't signed in. */
export async function caller(req: Request): Promise<Profile | null> {
  const auth = req.headers.get('Authorization');
  if (!auth) return null;
  const { data } = await asUser(req).auth.getUser();
  if (!data?.user) return null;
  const { data: p } = await admin().from('profiles').select('*').eq('id', data.user.id).single();
  return (p as Profile) ?? null;
}

export function stripe(): Stripe {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. Add it under Edge Functions > Secrets.');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

export async function getSecret(db: SupabaseClient, key: string): Promise<string | null> {
  const fromEnv = env(key.toUpperCase());
  if (fromEnv) return fromEnv;
  const { data } = await db.from('secrets').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

export async function setSecret(db: SupabaseClient, key: string, value: string) {
  await db.from('secrets').upsert({ key, value, updated_at: new Date().toISOString() });
}

export function randomKey(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where Stripe should send people back to. Uses settings.app_url, else the calling page's origin. */
export async function appUrl(db: SupabaseClient, req: Request): Promise<string> {
  const { data } = await db.from('settings').select('app_url').eq('id', 1).single();
  const u = data?.app_url || req.headers.get('origin') || '';
  return u.replace(/\/$/, '');
}

export const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()); // YYYY-MM-DD

export const addDays = (ymd: string, n: number) => {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json(); } catch { return {}; }
}
