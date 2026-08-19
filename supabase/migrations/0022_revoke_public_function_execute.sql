-- ============================================================================
-- 0022_revoke_public_function_execute.sql
--
-- Fixes the Supabase Advisor "Public Can Execute SECURITY DEFINER Function"
-- warnings on admin_* and other functions.
--
-- Root cause: 0004_security_hardening.sql ran
--   revoke execute on all functions in schema public from public;
--   revoke execute on all functions in schema public from anon;
-- exactly once, against the functions that existed *at that time*. Postgres
-- grants EXECUTE to PUBLIC by default on every newly created function unless
-- that default is explicitly revoked — and every function (or, for functions
-- like admin_create_order_v1 that gained new parameters over time, every new
-- *overload*, since Postgres identifies a function by name **and** argument
-- types) created in a migration after 0004 never went through that revoke.
-- The `grant execute ... to authenticated` lines in those later migrations
-- only ever added a grant; they never removed the PUBLIC one sitting
-- alongside it. Net effect: those functions have been callable by anyone,
-- including fully anonymous requests with no session at all — not just
-- `authenticated` users.
--
-- Impact: most of these functions do check `role = 'admin'`/similar inside
-- the function body before doing anything destructive, so this was not a
-- silent data-loss hole. But it does mean any anonymous script can discover
-- these RPC endpoints (PostgREST auto-exposes every function reachable by
-- the connecting role at /rest/v1/rpc/<name>) and hit them at will, each
-- call still opening a real Postgres transaction before being rejected by
-- the internal check. If something out there is currently hammering this
-- project, this was one of the doors it could be doing it through — closing
-- it means those calls now get rejected by PostgREST/Postgres at the grant
-- check, before a transaction is even opened, which is strictly cheaper than
-- the previous behaviour.
--
-- Fix: re-run the same blanket revoke 0004 used (safe to run repeatedly —
-- it now also catches every function/overload added since), and add an
-- ALTER DEFAULT PRIVILEGES rule so any function created by this role from
-- now on no longer needs a manual revoke to close this gap.
-- ============================================================================

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

-- Applies to functions created after this point by whichever role runs this
-- migration (typically `postgres`, via the SQL Editor / migration runner).
-- Existing `grant execute on function ... to authenticated` statements
-- elsewhere are untouched — this only removes the PUBLIC default going
-- forward, it does not grant or revoke anything for `authenticated`.
alter default privileges in schema public revoke execute on functions from public;

notify pgrst, 'reload schema';
