# Picker & Sort Wall — PWA

A single installable Progressive Web App for the Picker, Sort Wall, and Admin
roles, backed entirely by Supabase's free tier. See
[`docs/TECHNICAL_DESIGN_DOCUMENT.md`](../docs/TECHNICAL_DESIGN_DOCUMENT.md)
at the repo root for the full architecture rationale — this README only
covers how to actually run and deploy what's in this folder.

## What's here

- `src/` — the React + TypeScript PWA (Vite). One app, role-gated
  routes/tabs (`/picker`, `/sort-wall`, `/admin`) — not three separate apps.
- `../supabase/migrations/` — the Postgres schema, Row Level Security
  policies, and RPC functions that back this app (applied to your Supabase
  project, not run by this frontend).
- `../supabase/seed.sql` — optional local/dev-only test data.

## 1. Apply the database migrations

This environment does not have a Supabase CLI access token, so the
migrations were written and validated as plain SQL (see the header comments
in each file, and the smoke-test transcripts referenced in the PR) so you
can apply them however is convenient:

**Option A — Supabase SQL editor (fastest, no CLI needed):**

1. Open your project's SQL editor: `https://supabase.com/dashboard/project/aetrwtubfifljkxwocpy/sql/new`
2. Copy the complete generated `supabase/setup.sql` file.
3. Paste it into the SQL editor and click **Run**.

`setup.sql` combines all numbered migrations in the correct order, including
the optional order metadata (`0005_order_fragile.sql`) and the operations
upgrade (`0006_operations_capacity_and_qr.sql`).

**Option B — Supabase CLI (if you link the project locally):**

```bash
supabase link --project-ref aetrwtubfifljkxwocpy
supabase db push
```

Both options are idempotent-safe to re-run from a clean project, but are
**not** designed to be re-run against a project that already has data in
these tables (they use `create table`, not `create table if not exists`,
by design — Section 5 of the design doc explains why silent schema drift is
worse than a loud failure here). If you need to iterate on the schema after
first applying it, write a new numbered migration rather than editing
the original migrations in place, then add a new numbered migration and
regenerate the one-file setup with:

```bash
node scripts/build-supabase-setup.mjs
```

### Upgrade an existing project

If this project is already running, do **not** paste the whole `setup.sql`
again. Run only the newest numbered migrations you have not applied yet in
the Supabase SQL Editor (for example `0010` … `0013`).

- **0011** — `admin_create_picker_v1` (Manpower create without an Edge Function)
- **0012** — clearer picker-create validation errors / broader mobile formats
- **0013** — ensures `orders.is_fragile` exists (needed after 0010 if 0005 was skipped)
- **0021** — rewrites every RLS policy so `auth.uid()` / helper-function calls
  are computed once per query instead of once per row (fixes the Supabase
  Advisor "Auth RLS Initialization Plan" warnings and the CPU-usage spike
  that comes with them — see Section 11.6.1 of the design doc). No behaviour
  change, just cheaper policy evaluation; safe to run on a live project.

Once it has run, the Admin panel's **Reset test orders** section can clear the
current test orders safely. It requires typing `RESET ALL TEST ORDERS`; this
deletes orders, bag scans and order QR codes, while retaining users,
warehouses, walls, pigeon holes and their QR codes.

## 2. Get your anon/publishable key

Supabase Dashboard → Project Settings → API → the value labelled
`anon` / `public`. This key is safe to ship in the browser bundle (Row Level
Security is the real authorization boundary — see Section 11.6 of the design
doc) — **never** use the `service_role` key here.

## 3. Configure environment variables

```bash
cp .env.example .env.local
# edit .env.local and paste your anon key
```

`.env.local` is git-ignored; never commit real keys (not that the anon key is
secret, but keep the habit for when you eventually add server-side secrets
via Edge Functions).

## 4. Create your first Admin user

There is no self-signup (by design — Section 11.2). Bootstrap one Admin
account manually:

1. Supabase Dashboard → Authentication → Users → **Add user** → create
   yourself with an email + password.
2. A `profiles` row is auto-created for that user (via the
   `handle_new_auth_user` trigger in `0003_functions.sql`) with `role =
   'picker'` by default. Promote yourself to admin by running this in the
   SQL editor (replace the email):

   ```sql
   update profiles set role = 'admin', is_super_admin = true
   where email = 'you@example.com';
   ```

3. Every subsequent user (pickers, warehouse staff, ops managers) should be
   created the same way — Dashboard → Add user — then have their role set
   either via the SQL editor or eventually via the Admin tab once that
   screen grows role-management (Section 12.5 notes this as a deliberate
   MVP simplification, not an oversight).

## 5. Run locally

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL. Camera scanning requires
HTTPS in real deployments, but `localhost` is treated as a secure context by
browsers, so it works fine for local development.

## 6. Try the end-to-end flow

Once signed in as an Admin:

1. **Admin tab** — you'll need at least one warehouse + sort wall + pigeon
   holes to exist first. These are created directly via SQL for now (see
   `../supabase/seed.sql`), since warehouse/sort-wall setup is rare enough
   that it doesn't need its own screen yet (Section 12.3 covers what the
   fuller version looks like later). Once a sort wall exists, use the Admin
   tab to create pigeon holes and a warehouse gate code, then create a test
   order.
2. Sign in as (or create) a **Picker** account, go to the Picker tab, accept
   the order, scan the shared bag QR code once per bag (the on-screen count
   ticks up each time — remember, per Section 9.1, this proves the picker
   performed N scan actions against the correct order code, not that N
   distinct physical bags were presented).
3. Tap through to "Go to dropoff," scan the warehouse gate QR code
   (generated in step 1), then scan the bag again to see which pigeon hole
   it's assigned to, then scan that hole's QR code.
4. Sign in as a **Warehouse Staff / Ops Manager** account, open the Sort
   Wall tab, and mark the order collected once it shows "ready for pickup."

For testing without printed QR codes, use each scanner screen's "Can't scan?
Enter code manually" fallback and type the `code_value` shown in the
`qr_codes` table.

### Automated checks

```bash
npm run lint      # oxlint
npm run test      # vitest unit tests
npm run build     # tsc -b && vite build
```

There's also a browser-level smoke test (`npm run test:e2e`) that renders the
Picker/Admin screens against a mocked Supabase backend using the system
Chrome — no real project credentials needed. It has caught real interaction
bugs that a build/lint/unit-test pass alone would not (a fixed bottom bar
covering a button on short screens, an invisible close icon, a stale DOM
event reference after an `await`). Run a dev server first, then:

```bash
npm run dev -- --port 5175 --host 127.0.0.1   # in one terminal
CHROME_PATH=/usr/local/bin/google-chrome npm run test:e2e   # in another
```

`CHROME_PATH` defaults to `/usr/local/bin/google-chrome`; point it at any
Chrome/Chromium binary you have installed. This script isn't wired into CI —
it's a manual regression aid for anyone touching Picker/Admin interaction
logic.

## 7. Build & deploy

```bash
npm run build
```

Outputs a static `dist/` folder. The repository root includes `vercel.json`,
so **Vercel Free** is the simplest deployment: import the GitHub repository,
add the two `VITE_*` variables from step 3, and click Deploy. Vercel uses:

- install: `npm --prefix app ci`
- build: `npm --prefix app run build`
- output: `app/dist`

Cloudflare Pages also works: leave the root directory blank, use `npm run
build`, and set the output directory to `app/dist`.

## Known limitations of this first pass (see the design doc for the full list)

- **Shared order-level QR codes** (Section 9) — intentional MVP scope, not a
  bug. Per-bag unique codes are a documented future migration (Section 9.6),
  not implemented yet.
- **No real Store API integration** — orders are created via the Admin tab's
  `admin_create_order_v1` RPC, a stand-in for a real webhook (Section 3.1).
- **No automated delivery-partner integration** — dispatch is a manual "mark
  collected" action (Section 13.5).
- **No push notifications / SMS** — everything is in-app + Realtime/polling
  (Section 14), consistent with the "free resources only" constraint.
- **Admin user/role management** is SQL-editor-only for now (Section 12.5) —
  a proper screen is a fast follow, not core to proving the workflow.
