-- ============================================================================
-- 0012_picker_create_clear_errors.sql
-- Broader mobile normalisation and field-specific human-readable errors
-- for admin_create_picker_v1.
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
  if v_raw = '' then
    return null;
  end if;

  v_raw := regexp_replace(v_raw, '[^\d+]', '', 'g');
  -- Already E.164.
  if v_raw ~ '^\+[1-9]\d{7,14}$' then
    return v_raw;
  end if;

  v_digits := regexp_replace(v_raw, '\D', '', 'g');
  -- Strip international access prefix 00.
  if v_digits ~ '^00[1-9]\d{7,14}$' then
    v_digits := substr(v_digits, 3);
  end if;

  -- Mall default: UAE local 05XXXXXXXX / 5XXXXXXXX -> +9715XXXXXXXX.
  if v_digits ~ '^0?5\d{8}$' then
    return '+971' || regexp_replace(v_digits, '^0', '');
  end if;

  -- Country code without +: 9715XXXXXXXX or any 8–15 digit international number.
  if v_digits ~ '^[1-9]\d{7,14}$' then
    return '+' || v_digits;
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
  v_bytes bytea;
  v_i integer;
  v_profile profiles;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'admin' then
    raise exception 'Only an admin can create pickers.' using errcode = '42501';
  end if;

  if length(v_full_name) < 2 then
    raise exception 'Enter the picker''s full name (at least 2 characters).' using errcode = '22023';
  end if;

  if trim(coalesce(p_phone, '')) = '' then
    raise exception 'Enter a mobile number.' using errcode = '22023';
  end if;

  if v_phone is null then
    raise exception 'Mobile number "%s" is not recognised. Use a UAE number like 0501234567, or an international number like +971501234567.',
      trim(p_phone)
      using errcode = '22023';
  end if;

  if v_login_code = '' then
    raise exception 'Enter a login code (6 to 8 digits).' using errcode = '22023';
  end if;

  if v_login_code !~ '^\d{6,8}$' then
    raise exception 'Login code must be 6 to 8 digits only (no letters or spaces). You entered "%s".',
      v_login_code
      using errcode = '22023';
  end if;

  if not v_all_zones and v_zone is null then
    raise exception 'Choose a zone (for example C), or tick All Zones.' using errcode = '22023';
  end if;

  if not v_all_zones and not exists (
    select 1 from zones where code = v_zone and is_active
  ) then
    -- Allow free-typed zones when the zones table is empty (first-time setup),
    -- but reject unknown codes once zones have been configured.
    if exists (select 1 from zones where is_active) then
      raise exception 'Zone "%s" is not in the active zone list. Pick one of the suggested zones, or tick All Zones.',
        v_zone
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1 from profiles
    where role = 'picker' and status <> 'offboarded' and phone_e164 = v_phone
  ) then
    raise exception 'Mobile %s is already assigned to another active picker.', v_phone
      using errcode = '23505';
  end if;

  v_email := 'p' || regexp_replace(v_phone, '\D', '', 'g') || '@picker.internal';

  for v_i in 1..12 loop
    v_bytes := gen_random_bytes(4);
    v_picker_code := 'PKR-' ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 0) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 1) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 2) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 3) % length(v_alphabet)), 1);
    exit when not exists (select 1 from profiles where picker_code = v_picker_code);
  end loop;

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
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
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
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
      raise exception 'Mobile %s (or its login email) is already registered. Use a different mobile number.',
        v_phone
        using errcode = '23505';
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
    raise exception 'The login account was created, but the picker profile could not be saved. Contact support with mobile %s.',
      v_phone
      using errcode = 'P0001';
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
