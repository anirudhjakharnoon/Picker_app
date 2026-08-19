# Picker & Sort Wall PWA

One website/PWA for Picker, Sort Wall, and Admin, backed by Supabase Free.

The application code is now merged into `main`.

## Before you start



1. [Supabase](https://supabase.com/) — you already created project
   `aetrwtubfifljkxwocpy`.
2. [Vercel](https://vercel.com/signup) or
   [Cloudflare](https://dash.cloudflare.com/sign-up) — only needed when you
   want a public website. Local testing does not need either one.
3. GitHub — already used by this repository.

There is no SMS OTP, paid push service, paid map, or paid backend server.
Login uses Supabase email/password, which is included in its free tier.

---

# Part 1 — Put the database into Supabase

## Step 1: Open the one-file database setup

Open:

[`supabase/setup.sql`](supabase/setup.sql)

Click **Raw**, then select all and copy the complete file.

## Step 2: Run it in Supabase

1. Open the project's
   [Supabase SQL Editor](https://supabase.com/dashboard/project/aetrwtubfifljkxwocpy/sql/new).
2. Click **New query** if an empty editor is not already open.
3. Paste everything copied from `supabase/setup.sql`.
4. Click **Run**.
5. Wait until Supabase shows **Success. No rows returned** (other harmless
   success messages are also possible).

Do not paste the file a second time. It creates the database tables and is
intended for a new/empty project.

> Already set up an earlier version? `supabase/setup.sql` now also includes
> `0005_order_fragile.sql`, which powers the "Fragile Items" badge and store
> display names. If you set up before this file existed, open
> [`supabase/migrations/0005_order_fragile.sql`](supabase/migrations/0005_order_fragile.sql),
> paste it into a new SQL Editor query, and Run it once. The app works
> without it; running it just lights up those extras.

## Step 3: Create the demo warehouse and pigeon holes

1. Open [`supabase/bootstrap_demo.sql`](supabase/bootstrap_demo.sql).
2. Click **Raw**, copy the whole file.
3. Return to Supabase SQL Editor and create a **New query**.
4. Paste the file and click **Run**.
5. At the bottom, Supabase displays:
   - the warehouse ID;
   - the warehouse gate code; and
   - eight pigeon-hole codes.

The script is safe to run again if necessary.

---

# Part 2 — Create login accounts

## Step 4: Create your Admin account

1. In Supabase, open **Authentication** → **Users**.
2. Click **Add user** → **Create new user**.
3. Enter your email and a password.
4. Turn on **Auto Confirm User** if Supabase displays that option.
5. Click **Create user**.
6. Open **SQL Editor** → **New query** and run this, replacing the email:

```sql
update profiles
set role = 'admin', is_super_admin = true
where email = 'YOUR-EMAIL@example.com';
```

You now have an Admin login.

## Step 5: Create a Picker account

1. Return to **Authentication** → **Users**.
2. Click **Add user** → **Create new user**.
3. Use a different email and password.
4. Enable **Auto Confirm User**, then create the user.

New users are Pickers by default, so no SQL is needed.

## Step 6: Create a Warehouse Staff account

1. Create one more user in **Authentication** → **Users**.
2. Open SQL Editor and run the query below. Replace the email:

```sql
update profiles
set
  role = 'warehouse_staff',
  warehouse_id = (
    select id from warehouses
    where name = 'Demo Warehouse'
    limit 1
  )
where email = 'WAREHOUSE-EMAIL@example.com';
```

Use separate email accounts for Admin, Picker, and Warehouse Staff. This
keeps the audit trail clear.

---

# Part 3 — Get the public Supabase key

## Step 7: Copy the anon/publishable key

1. In Supabase, open **Project Settings**.
2. Open **API Keys** (in some dashboard versions this is called **API**).
3. Copy the **Publishable** key. If only legacy keys are shown, copy the
   **anon public** key.

Never copy the `service_role` or secret key into this app.

The project URL is already:

```text
https://aetrwtubfifljkxwocpy.supabase.co
```

---

# Part 4A — Run on your computer first

You need [Node.js](https://nodejs.org/) installed. Use the current LTS
version.

Open a terminal in this repository and run:

```bash
cd app
npm install
cp .env.example .env.local
```

Open `app/.env.local` in a text editor. Replace:

```text
replace-with-your-anon-public-key
```

with the Publishable/anon key copied from Supabase.

Then run:

```bash
npm run dev
```

Open the URL printed in the terminal, normally:

```text
http://localhost:5173
```

Log in using the Admin, Picker, or Warehouse Staff email/password you created.

---

# Part 4B — Put it online for free with Vercel (recommended)

Yes, Vercel works. The previous Cloudflare error:

```text
Could not read package.json ... /repo/package.json
```

means the host ran the build from the repository root while the frontend
package lives inside `app/`. It was a folder-configuration problem, not an
application error. This repository now includes `vercel.json` and a root
`package.json`, so Vercel knows the correct commands and output folder.

1. First merge the Vercel deployment-fix pull request into `main`.
2. Open [Vercel's New Project page](https://vercel.com/new).
3. Sign in with GitHub.
4. Find `Picker_app` and click **Import**.
5. Vercel reads `vercel.json`; leave these automatically detected values
   unchanged:

| Setting | Value |
|---|---|
| Framework | `Vite` |
| Install command | `npm --prefix app ci` |
| Build command | `npm --prefix app run build` |
| Output directory | `app/dist` |

6. Open **Environment Variables** and add:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://aetrwtubfifljkxwocpy.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase Publishable/anon key |

7. Click **Deploy**.
8. When deployment finishes, click **Visit**. Vercel gives you a free URL
   similar to `https://picker-app-xxxxx.vercel.app`.
9. Copy that URL.
10. In Supabase, open **Authentication** → **URL Configuration**:
    - Set **Site URL** to the Vercel URL.
    - Add `https://YOUR-VERCEL-URL/**` under **Redirect URLs**.
    - Save.

The `vercel.json` rewrite makes direct links such as `/picker`, `/sort-wall`,
and `/admin` load the PWA instead of returning a 404.

---

# Part 4C — Alternative: Cloudflare Pages

Do this after local testing works.

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Open **Workers & Pages**.
3. Click **Create** → **Pages** → **Connect to Git**.
4. Connect GitHub and select the `Picker_app` repository.
5. After the deployment-fix pull request is merged, either use the repository
   root with:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | leave blank |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `app/dist` |

6. Add these environment variables:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://aetrwtubfifljkxwocpy.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your Publishable/anon key |

7. Click **Save and Deploy**.
8. Cloudflare gives you a free URL ending in `.pages.dev`. Open it in Chrome.

The repository includes `app/public/_redirects`, so `/picker`, `/sort-wall`,
and `/admin` work when opened directly on Cloudflare Pages.

---

# Part 5 — Test the complete workflow

## Step 8: Create a test order

1. Log in with the Admin account.
2. Open the **Admin** tab.
3. Under **Create test order**, enter:
   - Store reference: `STORE-DEMO`
   - Bag count: `3`
   - Floor: `2`
   - Zone: `North`
   - Address: `12 Market Rd`
4. Click **Create order**.
5. The generated shared bag code appears at the top. Click **Copy**.

## Step 9: Pick the order

1. Sign out.
2. Sign in using the Picker account.
3. Click **Go online**.
4. Accept the available order.
5. Open the order and click **Pick order**.
6. Tap **Can't scan? Enter code manually**.
7. Paste the bag code and submit it three times—once for each expected bag.
8. Click **Done**, then **Go to dropoff**.

For this MVP, every bag in an order uses the same code. The count increases
once per scan action.

## Step 10: Arrive and sort

1. On the warehouse gate scanner, tap manual entry.
2. Paste the `GATE-...` code displayed when
   `supabase/bootstrap_demo.sql` ran.
3. The app assigns a pigeon hole.
4. Scan/enter the shared bag code.
5. Enter the code for the assigned pigeon hole.
6. Repeat until all three bags are sorted.

You can find gate and hole codes again with:

```sql
select code_type, code_value, entity_id
from qr_codes
where status = 'active'
order by code_type, created_at;
```

## Step 11: Dispatch from the Sort Wall

1. Sign out.
2. Sign in using the Warehouse Staff account.
3. Open the **Sort Wall** tab.
4. Find the green/filled pigeon hole.
5. Click **Mark collected**.
6. The order becomes dispatched and the pigeon hole becomes free.

---

# Troubleshooting

## Can't log in after toggling Vercel "Deployment Protection" off/on

This app authenticates entirely client-side, straight from the browser to
Supabase (email/password via `supabase.auth.signInWithPassword`). There is no
server-side auth code in this repository, so if login suddenly stops working
right after you flipped a **Vercel** setting off and back on, the cause is
almost always Vercel's **Deployment Protection** (also shown as "Vercel
Authentication" / password protection), not this app's code.

What happens: when Deployment Protection is enabled with scope **All
Deployments**, Vercel puts its own login wall in front of *every* URL for the
project — including your production domain — before your app's HTML/JS is
ever served. Anyone without a Vercel account for your team (every Picker and
Warehouse Staff user) gets stuck on Vercel's "Authentication Required" page
and never even reaches this app's own Sign In screen. Turning the toggle off
then back on can silently reset the scope to **All Deployments** instead of
the "previews only" scope you likely want.

How to confirm this is the cause:

1. Open your production URL in a private/incognito window (so you aren't
   auto-passed through by an existing Vercel session cookie).
2. If you see a **Vercel** login/access-request page instead of this app's
   own "Dubai Mall" Sign In screen, Deployment Protection is the problem —
   this is a Vercel project setting, not something fixable in the app code.

How to fix it:

1. In the [Vercel dashboard](https://vercel.com/dashboard), open your
   project → **Settings** → **Deployment Protection**.
2. Under **Vercel Authentication**, either:
   - turn it **off** entirely, or
   - keep it on but set the scope to **Standard Protection** (protects
     preview deployments and the long auto-generated `*.vercel.app` URLs,
     but leaves your production domain public), instead of **All
     Deployments** (which also gates production).
3. Click **Save**, then reload your production URL in a private window to
   confirm the app's own Sign In screen loads.
4. If you specifically want the whole site gated by Vercel *in addition to*
   normal app logins, you'll need to give every Picker/Warehouse Staff user
   a Vercel account with project access (or a shared access link) — this app
   was not designed to run behind that wall, since it relies on Supabase's
   own login as the access boundary (see `docs/TECHNICAL_DESIGN_DOCUMENT.md`
   Section 11.6).

## “Could not query the database for the schema cache. Retrying.”

This is **Supabase's own backend error** (`PGRST002`), not something this
app generates — it means PostgREST (Supabase's REST API layer) could not
query the underlying Postgres database to build its schema cache. It shows
up wherever the app happens to be reading data at the time (often the sign-in
screen, because that's where `profiles` is fetched right after a successful
password check), but it has nothing to do with the email/phone or password
you typed — every login attempt will fail identically while it lasts.

The app now retries this automatically for a few seconds (with a "Retrying
automatically…" hint and a manual **Retry** button) since it's usually a
short-lived blip, for example right after running a migration, or the
project waking back up from being paused. If it does not clear up within a
minute or two:

1. Open the [Supabase dashboard](https://supabase.com/dashboard/project/aetrwtubfifljkxwocpy)
   and check for a "paused" / "restoring" banner. Free-tier projects
   auto-pause after a week of inactivity — click **Restore project** if so.
2. **Project Settings → Infrastructure/General → Restart project.** This is
   the most reliable fix for a stuck PostgREST schema cache.
3. Check **Reports → Database** for CPU, memory, disk, and connection-count
   spikes — running several large migrations back to back (or re-running
   `setup.sql`) can transiently exhaust the free tier's limited resources.
4. Check **Logs → Postgres logs** around the time it started for messages
   like "too many connections", "out of memory", or disk-full errors.

Once the project is healthy again, reload the app (or tap **Retry**) and
sign in as usual — no code change or redeploy is needed.

## “Invalid login credentials”

- Confirm the user exists under Supabase **Authentication** → **Users**.
- Confirm **Auto Confirm User** was enabled, or confirm the user's email.
- Re-enter the password.

## “Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY”

Your `.env.local`, Vercel, or Cloudflare environment variables are missing.
Repeat Part 3 and Part 4.

## I only see one tab

That is expected:

- Picker login → Picker tab
- Warehouse Staff login → Sort Wall tab
- Admin login → Admin and Sort Wall tabs

Permissions are enforced by Supabase, not only hidden visually.

## Camera does not open

- Camera access needs HTTPS, except `localhost`.
- Allow camera permission in Chrome.
- You can always use **Can't scan? Enter code manually**.

## “Could not read package.json” during deployment

The host is building from the wrong folder or an old commit. Merge the latest
deployment-fix pull request, redeploy from `main`, and use the exact Vercel or
Cloudflare settings in Part 4B/4C.

---

## More documentation

- [Detailed app documentation](app/README.md)
- [Technical architecture](docs/TECHNICAL_DESIGN_DOCUMENT.md)
- [Numbered database migrations](supabase/migrations/)
- [Moving to a fresh Supabase project](docs/NEW_SUPABASE_PROJECT.md) — verified
  runbook for rebuilding the backend from `supabase/setup.sql` when a project is
  unrecoverable, including what to salvage first and what to harden before
  reopening to traffic.
