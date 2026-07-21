// Concatenates the ordered Supabase migrations into one beginner-friendly
// `supabase/setup.sql` file for copy/paste into the Supabase SQL Editor.
//
// The numbered migration files remain the source of truth. Run this script
// after changing them:
//   node scripts/build-supabase-setup.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(root, 'supabase', 'migrations');
const output = resolve(root, 'supabase', 'setup.sql');

const files = readdirSync(migrationsDir)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

const header = `-- ============================================================================
-- GENERATED FILE — beginner one-click Supabase setup
--
-- Paste this entire file into Supabase Dashboard > SQL Editor > New query,
-- then click Run. The numbered files in supabase/migrations/ are the source
-- of truth; regenerate this file with:
--   node scripts/build-supabase-setup.mjs
--
-- Generated from:
${files.map((name) => `--   - ${name}`).join('\n')}
-- ============================================================================

`;

const body = files
  .map((name) => {
    const sql = readFileSync(resolve(migrationsDir, name), 'utf8').trim();
    return `\n-- ======================== BEGIN ${name} ========================\n\n${sql}\n\n-- ========================= END ${name} =========================\n`;
  })
  .join('\n');

writeFileSync(output, header + body + '\n');
console.log(`Wrote ${output} from ${files.length} migrations.`);
