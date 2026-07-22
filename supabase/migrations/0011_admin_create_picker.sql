-- ============================================================================
-- 0011_admin_create_picker.sql
-- Create pickers from the Manpower UI without a deployed Edge Function.
-- Inserts into auth.users + auth.identities (bcrypt via pgcrypto), then
-- provisions the application profile. Admin-only.
-- ============================================================================

create or replace function admin_normalise_picker_phone_v1(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_raw text := trim(coalesce(p_phone, ''));
  v_digits text;
begin
  v_raw := regexp_replace(v_raw, '[^\d+]', '', 'g');
  if v_raw ~ '^\+[1-9]\d{7,14}$' then
    return v_raw;
  end if;
  v_digits := regexp_replace(v_raw, '\D', '', 'g');
  -- Mall deployment default: UAE local mobile 05XXXXXXXX / 5XXXXXXXX -> +9715XXXXXXXX.
  if v_digits ~ '^0?5\d{8}$' then
    return '+971' || regexp_replace(v_digits, '^0', '');
  end if;
  return null;
end;
$$;

create or replace function admin_create_picker_v1(
  p_full_name text,
  p_phone text,
  p_login_code text,
  p_zone text default null,
  p_all_zones boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $$
declare
  v_caller_role user_role;
  v_full_name text := trim(coalesce(p_full_name, ''));
  v_phone text := admin_normalise_picker_phone_v1(p_phone);
  v_login_code text := trim(coalesce(p_login_code, ''));
  v_all_zones boolean := coalesce(p_all_zones, false);
  v_zone text := case when v_all_zones then null else nullif(upper(trim(coalesce(p_zone, ''))), '') end;
  v_email text;
  v_user_id uuid := gen_random_uuid();
  v_picker_code text;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_i integer;
  v_profile profiles;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if length(v_full_name) < 2
     or v_phone is null
     or v_login_code !~ '^\d{6,8}$'
     or (not v_all_zones and v_zone is null) then
    raise exception 'invalid picker details' using errcode = '22023';
  end if;

  if exists (
    select 1 from profiles
    where role = 'picker' and status <> 'offboarded' and phone_e164 = v_phone
  ) then
    raise exception 'mobile already exists' using errcode = '23505';
  end if;

  v_email := 'p' || regexp_replace(v_phone, '\D', '', 'g') || '@picker.internal';

  -- Generate a short unique picker code (PKR-XXXX).
  for v_i in 1..12 loop
    v_picker_code := 'PKR-' ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 0) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 1) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 2) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 3) % length(v_alphabet)), 1);
    exit when not exists (select 1 from profiles where picker_code = v_picker_code);
  end loop;

  begin
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_login_code, gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', v_full_name, 'phone_e164', v_phone),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );

    insert into auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email',
      v_user_id::text,
      now(),
      now(),
      now()
    );
  exception
    when unique_violation then
      raise exception 'mobile already exists' using errcode = '23505';
  end;

  update profiles
  set role = 'picker',
      full_name = v_full_name,
      phone_e164 = v_phone,
      picker_code = v_picker_code,
      home_zone = v_zone,
      all_zones = v_all_zones,
      status = 'active',
      login_code_rotated_at = now(),
      updated_at = now()
  where id = v_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'could not provision picker profile' using errcode = 'P0001';
  end if;

  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    'picker.create',
    'profile',
    v_user_id,
    jsonb_build_object('zone', v_zone, 'all_zones', v_all_zones)
  );

  return jsonb_build_object(
    'id', v_profile.id,
    'picker_code', v_profile.picker_code,
    'phone_e164', v_profile.phone_e164,
    'full_name', v_profile.full_name,
    'home_zone', v_profile.home_zone,
    'all_zones', v_profile.all_zones,
    'login_code', v_login_code
  );
end;
$$;

revoke all on function admin_normalise_picker_phone_v1(text) from public;
revoke all on function admin_create_picker_v1(text, text, text, text, boolean) from public;
grant execute on function admin_create_picker_v1(text, text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';
