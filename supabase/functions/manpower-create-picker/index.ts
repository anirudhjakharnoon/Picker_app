// Deploy with:
//   supabase functions deploy manpower-create-picker --no-verify-jwt
//
// This function deliberately verifies the caller's bearer token itself so it
// can use the service role ONLY on behalf of an authenticated admin. Never put
// SUPABASE_SERVICE_ROLE_KEY in a VITE_ variable or the browser bundle.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGINS') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function normalisePhone(value: string): string | null {
  const raw = value.trim().replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  // Mall deployment default: UAE local mobile number 05XXXXXXXX -> +9715XXXXXXXX.
  if (/^0?5\d{8}$/.test(raw)) return `+971${raw.replace(/^0/, '')}`;
  return null;
}

function pickerCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = crypto.getRandomValues(new Uint8Array(4));
  return `PKR-${[...random].map((value) => alphabet[value % alphabet.length]).join('')}`;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return reply({ error: 'unauthorized' }, 401);

  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth } = await userClient.auth.getUser();
  if (!auth.user) return reply({ error: 'unauthorized' }, 401);

  const admin = createClient(url, serviceKey);
  const { data: caller } = await admin.from('profiles').select('role').eq('id', auth.user.id).single();
  if (caller?.role !== 'admin') return reply({ error: 'forbidden' }, 403);

  const body = await request.json();
  const fullName = String(body.full_name ?? '').trim();
  const phone = normalisePhone(String(body.phone ?? ''));
  const loginCode = String(body.login_code ?? '');
  const allZones = Boolean(body.all_zones);
  const zone = allZones ? null : String(body.zone ?? '').trim().toUpperCase();
  if (fullName.length < 2 || !phone || !/^\d{6,8}$/.test(loginCode) || (!allZones && !zone)) {
    return reply({ error: 'invalid_picker_details' }, 422);
  }

  const syntheticEmail = `p${phone.replace(/\D/g, '')}@${Deno.env.get('PICKER_EMAIL_DOMAIN') ?? 'picker.internal'}`;
  const code = pickerCode();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: syntheticEmail,
    password: loginCode,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone_e164: phone },
  });
  if (createError || !created.user) {
    return reply({ error: createError?.message.includes('already') ? 'mobile_already_exists' : 'could_not_create_picker' }, 409);
  }

  const { error: profileError } = await admin.from('profiles').update({
    role: 'picker',
    full_name: fullName,
    phone_e164: phone,
    picker_code: code,
    home_zone: zone,
    all_zones: allZones,
    status: 'active',
    login_code_rotated_at: new Date().toISOString(),
  }).eq('id', created.user.id);
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return reply({ error: 'could_not_provision_picker' }, 500);
  }

  await admin.from('audit_logs').insert({
    actor_user_id: auth.user.id,
    action: 'picker.create',
    target_type: 'profile',
    target_id: created.user.id,
    metadata: { zone, all_zones: allZones },
  });
  return reply({
    id: created.user.id,
    picker_code: code,
    phone_e164: phone,
    full_name: fullName,
    home_zone: zone,
    all_zones: allZones,
    login_code: loginCode,
  }, 201);
});
