-- ============================================================================
-- 0023_guard_admin_list_pickers.sql
--
-- Adds the missing caller-role check to admin_list_pickers_v1.
--
-- Every other admin_* RPC in this schema is SECURITY DEFINER *and* verifies the
-- caller is an admin in its own body, because `authenticated` holds EXECUTE on
-- the browser-facing RPC surface (see 0004_security_hardening.sql) — the grant
-- is not the authorization boundary, the in-function check is.
-- admin_list_pickers_v1 (0010_auto_assignment_manpower.sql) was the one that
-- never got that check, so any signed-in user — including any picker — could
-- call /rest/v1/rpc/admin_list_pickers_v1 and read the whole picker roster.
--
-- The leak was partial, not total: the function already masks picker_code
-- ('PKR-•••X') and phone_e164 ('••••1234'). What it did expose to any picker
-- was every picker's full name, home zone, active/suspended status, live
-- online state, current order count, and the last four digits of their mobile.
-- That is roster data an individual picker has no reason to enumerate, and the
-- last-4 plus full name is a mildly useful starting point against a login
-- scheme whose second factor is a 6–8 digit code, so it is worth closing.
--
-- This also clears one entry from the Advisor's "Signed-In Users Can Execute
-- SECURITY DEFINER Function" (0029) list. The remaining entries for the other
-- admin_*/scan_*/accept_* RPCs are expected: those functions are deliberately
-- SECURITY DEFINER so they can enforce the order state machine while bypassing
-- RLS, and each already gates itself on the caller's role.
--
-- Signature, return type, column order and masking are all unchanged, so the
-- Manpower panel keeps working exactly as before for admins.
-- ============================================================================

create or replace function admin_list_pickers_v1()
returns table(
  id uuid,
  picker_code_masked text,
  full_name text,
  phone_masked text,
  home_zone text,
  all_zones boolean,
  status user_status,
  is_online boolean,
  active_orders integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Uses auth_is_admin() rather than the `(select role ...) <> 'admin'` idiom
  -- the sibling functions use: that comparison yields NULL (not TRUE) when the
  -- caller has no profile row, so the `if` is skipped and the guard fails OPEN.
  -- auth_is_admin() is coalesce(auth_role() = 'admin', false), so a missing
  -- profile or absent session denies instead.
  if not auth_is_admin() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  return query
    select p.id,
      case when p.picker_code is null then null else 'PKR-•••' || right(p.picker_code, 1) end,
      p.full_name,
      case when p.phone_e164 is null then null else '••••' || right(p.phone_e164, 4) end,
      p.home_zone, p.all_zones, p.status, p.is_online, picker_active_order_count_v1(p.id)
    from profiles p
    where p.role = 'picker'
    order by p.full_name nulls last, p.created_at;
end;
$$;

grant execute on function admin_list_pickers_v1() to authenticated;
revoke execute on function admin_list_pickers_v1() from public;
revoke execute on function admin_list_pickers_v1() from anon;

notify pgrst, 'reload schema';
