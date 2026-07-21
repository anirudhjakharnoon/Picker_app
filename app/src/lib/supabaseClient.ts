import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly at startup rather than producing confusing runtime errors on
  // the first Supabase call. See app/README.md for setup instructions.
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in your Supabase anon key.'
  );
}

// Intentionally NOT using the generic `createClient<Database>(...)` form here.
// This project's src/types/database.ts is a hand-written reference (there is
// no `supabase gen types` access in this environment) and does not perfectly
// satisfy supabase-js's stricter generic constraints for every table. Query
// call sites cast results to the types in src/types/database.ts explicitly
// instead, which keeps this client resilient to that mismatch.
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
