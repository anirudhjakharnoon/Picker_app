# Moving to a fresh Supabase project

A runbook for rebuilding this app's backend on a new Supabase project, for when
the existing one is unrecoverable (for example: services returning `521` and not
coming back after a restart, because the instance has no CPU/memory headroom
left and Auth/PostgREST are dying on boot).

Everything the database needs is in **one file**: [`supabase/setup.sql`](../supabase/setup.sql).
It is generated from the numbered files in `supabase/migrations/` and already
contains every migration including the security and performance fixes (`0021`,
`0022`, `0023`). Regenerate it after any migration change with:

```bash
node scripts/build-supabase-setup.mjs
```

---

## Read this first: a new project alone may not fix the underlying problem

The old project was not killed by a bad schema — it ran out of resources while
serving an abnormal volume of traffic (on the order of billions of queries in a
day, far beyond anything this app's legitimate use produces). **A new project
will be destroyed the same way, within about a day, if whatever generated that
traffic is still pointed at it.**

Two things make a fresh project genuinely likely to help anyway:

- It gets a **new project ref, new URL, and new API keys.** If the load was
  external — a bot or scanner hammering the old, publicly-known URL — that
  breaks it outright, because the old URL stops existing.
- It starts with clean memory and disk, no swap thrashing, no bloat.

But before you delete the old project, spend five minutes on the step below.
Deleting it destroys the evidence of what killed it.

## Step 0 — Salvage the evidence before deleting (do not skip)

The dashboard's logs and reports usually remain viewable even while the database
itself is unreachable, so do this while the old project still exists:

1. **Auth logs**, last 24h — look for a large volume of failed sign-ins. Pickers
   sign in with a mobile number plus a 6–8 digit code, which is brute-forceable;
   a flood of `400`s against `p<digits>@picker.internal` identities would explain
   the load and means you must harden that before reopening to the internet.
2. **API Edge logs**, grouped by IP and path — a handful of IPs at very high
   request rates is the bot/attack signature. Broadly distributed, normal-looking
   traffic points elsewhere.
3. **Query Performance** — export the slow-query list.
4. Note whether the project overview shows a **restriction** banner (Supabase can
   restrict a free project that exceeds its limits, in which case a restart was
   never going to hold).

Also be aware: **you cannot back up the data while the database is unreachable.**
Deleting the project means accepting the loss of whatever is in it. For a demo /
pilot dataset that is fine; confirm that before you delete.

---

## Step 1 — Create the new project

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Pick a region close to your users (Dubai operations → a Middle East or
   Europe region).
3. Save the database password somewhere safe.
4. Wait until provisioning finishes.

## Step 2 — Create the schema (one paste)

1. Open **SQL Editor → New query**.
2. Paste the **entire** contents of [`supabase/setup.sql`](../supabase/setup.sql)
   and click **Run**.
3. Expect a success message with no rows. Do not paste it twice — it uses
   `create table` / `create type`, so a second run will error loudly by design.

This creates 17 tables, 17 RLS policies (all in the InitPlan-optimised form from
`0021`), and 92 functions with `anon` holding execute on none of them (`0022`).

## Step 3 — Create the demo warehouse and pigeon holes

1. **SQL Editor → New query** → paste [`supabase/bootstrap_demo.sql`](../supabase/bootstrap_demo.sql) → **Run**.
2. It prints the warehouse id, the warehouse gate code, and eight pigeon-hole
   codes. Keep these — you need the gate code to test the arrival scan.

Safe to re-run.

## Step 4 — Create your admin account

1. **Authentication → Users → Add user → Create new user.** Use your email and a
   password, and enable **Auto Confirm User**.
2. **SQL Editor**, replacing the email:

   ```sql
   update profiles set role = 'admin', is_super_admin = true
   where email = 'YOUR-EMAIL@example.com';
   ```

A `profiles` row is created automatically by the `handle_new_auth_user` trigger,
so you only need to promote it.

Pickers do **not** need to be created here — create them from the app's Manpower
panel once you can sign in, which routes through `admin_create_picker_v1`.

## Step 5 — Copy the new API key

**Project Settings → API Keys** → copy the **Publishable** key (or the legacy
**anon public** key if that is all that is shown). Never put the `service_role`
or secret key in a `VITE_` variable — anything `VITE_`-prefixed is bundled into
the browser.

## Step 6 — Repoint the code at the new project

The old project ref is hardcoded in several files. With `NEW_REF` set to your new
project ref, from the repo root:

```bash
NEW_REF=your_new_project_ref
grep -rl 'aetrwtubfifljkxwocpy' \
  --include='*.md' --include='*.json' --include='*.ts' --include='*.example' . \
  | xargs sed -i '' -e "s/aetrwtubfifljkxwocpy/$NEW_REF/g"   # GNU sed: drop the '' after -i
```

That covers `README.md`, `app/README.md`, `app/.env.example`,
`docs/TECHNICAL_DESIGN_DOCUMENT.md`, `app/src/types/database.ts` (a comment), and
`.cursor/mcp.json` if present. Review the diff before committing.

## Step 7 — Update the deployment environment variables

In **Vercel → your project → Settings → Environment Variables**, update:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://YOUR_NEW_REF.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the new Publishable/anon key |

Set them for **every** environment you deploy (Production *and* Preview — they
are scoped per environment, and a Preview build missing them ships a client that
cannot reach Supabase at all). Then **redeploy**: these are compiled into the
bundle at build time, so changing them without redeploying has no effect.

For local development, update `app/.env.local` the same way.

## Step 8 — Harden before reopening to the internet

Do these on the new project *before* real traffic returns, because they are what
stops a repeat:

1. **Enable Leaked Password Protection** — Authentication → Policies. Free,
   one click.
2. **Strengthen the picker login codes.** A 6-digit numeric code with a
   guessable phone-number identity is brute-forceable. Prefer 8 digits, and
   treat a flood of failed attempts as an incident.
3. **Check the Advisor** (Database → Advisors) after Step 2. The expected
   remaining warnings are the `0029` "Signed-In Users Can Execute SECURITY
   DEFINER Function" entries for the client-facing RPCs — those are by design
   here (see design doc §11.6.3: the in-function role check is the boundary, not
   the grant). You should **not** see the anonymous "Public Can Execute" variant.
4. **Consider turning Realtime off** for tables you can live without it on
   (Database → Replication). On the old project, Realtime's WAL decoding was the
   second most expensive query at 16.5% of total database time. `useOrders` and
   `usePigeonHoles` both already refetch when the tab regains focus, so the app
   degrades gracefully.
5. **Watch connections** in the first days:

   ```sql
   select count(*), state from pg_stat_activity group by state;
   ```

   A growing pile of `idle` connections is an early warning of the memory
   exhaustion that took the old project down.

## Step 9 — Verify

1. Open the deployed app and sign in as the admin from Step 4 → you should land
   on the Admin tab.
2. Manpower → create a picker with a mobile and login code.
3. Sign out, sign in as that picker (mobile + code) → the picker queue loads.
4. Admin → create a test order, then run the pick → arrive → sort flow using the
   gate and hole codes from Step 3.

If sign-in succeeds but the app returns to a "signed in, but the server is not
responding" screen, that is the profile read failing rather than your
credentials — check the Advisor and the project's health, not the login details.

---

## What was verified, and how

The two SQL files in this runbook were executed end to end against a clean
PostgreSQL 16 instance (with stand-ins for the `auth` schema objects that a real
Supabase project provides: `auth.users`, `auth.identities`, `auth.uid()`), with
`ON_ERROR_STOP` on:

- `setup.sql` — ran clean, zero errors; produced 17 tables, 17 RLS policies
  (17/17 using the `(select …)` InitPlan form), 92 functions, 0 of them
  executable by `anon`.
- `bootstrap_demo.sql` — ran clean; emitted the warehouse, gate code and eight
  pigeon-hole codes.
- `admin_create_order_v1(...)` as an admin → order created with status
  `available`.
- `admin_create_picker_v1('Test Picker','0501234567','123456','C',false)` →
  picker created, stored auth email `p971501234567@picker.internal` which
  matches exactly what the app's `toPickerAuthEmail()` computes for that mobile,
  the login code verifies against the stored bcrypt hash, and the account is
  auto-confirmed so nothing blocks the first sign-in.
- `admin_list_pickers_v1()` → returns the roster to an admin with masking intact
  (`••••4567`, `PKR-•••U`) and raises `not permitted` for a picker or an
  unauthenticated caller.
