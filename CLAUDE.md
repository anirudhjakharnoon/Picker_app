# CLAUDE.md

Guidance for Claude Code (and the `@claude` GitHub Action) when working in this repo.

## What this project is

Picker & Sort Wall PWA — one website/PWA serving Picker, Sort Wall, and Admin
roles, backed by Supabase (free tier). Login uses Supabase email/password. No
SMS OTP, paid push, paid map, or paid backend server.

## Stack

- React 19 + TypeScript, built with Vite. PWA.
- Routing: react-router-dom v7.
- Backend: Supabase (`@supabase/supabase-js`). SQL migrations live in `supabase/`.
- QR: `qr-scanner`, `qrcode`.
- Deploy targets: Vercel (`vercel.json`) and Cloudflare Workers (`wrangler.jsonc`).

## Layout

The application code lives under `app/`. The repo root holds orchestration
scripts and deploy config.

- `app/src/pages/` — top-level screens: Login, Picker, SortWall, Admin, Manpower.
- `app/src/lib/` — data + logic hooks: `useOrders`, `usePigeonHoles`, `useStores`,
  `actions.ts`, `supabaseClient.ts`, `pickerAuth.ts`. Unit tests sit next to the
  files they cover (`*.test.ts`).
- `app/src/components/` — shared UI (QR scanner/preview, swipe-to-accept, sheets, grids).
- `app/src/auth/` — auth context/provider.
- `app/src/types/database.ts` — generated Supabase types.
- `supabase/` — `setup.sql`, `seed.sql`, migrations, and edge functions.
- `docs/TECHNICAL_DESIGN_DOCUMENT.md` — design reference; read it before large changes.

## Commands

Run from the repo root:

- Install: `npm --prefix app ci`
- Dev server: `npm run dev`
- Build: `npm run build`
- Lint (oxlint): `npm run lint`
- Unit tests (vitest): `npm run test`
- E2E smoke: `npm --prefix app run test:e2e`

## Conventions

- TypeScript for all new files. Keep the existing functional-component + hooks style.
- Put business/data logic in `app/src/lib/` hooks, not in page components.
- Add or update a `*.test.ts` next to any logic you change in `app/src/lib/`.
- Before opening a PR, run lint and the unit tests and make sure they pass.
- Never commit secrets. Supabase keys and other config come from environment
  variables (see `app/.env.example`).

## Pull requests

- Branch off `main`. Keep PRs focused on one change.
- Write a clear PR description: what changed, why, and how it was tested.
- Do not push directly to `main` — always open a PR for review.
