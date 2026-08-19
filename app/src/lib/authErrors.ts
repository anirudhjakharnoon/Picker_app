/**
 * Classifies and humanises transient Supabase backend errors that surface
 * while loading the signed-in user's profile.
 *
 * `PGRST002` ("Could not query the database for the schema cache. Retrying.")
 * is Supabase's own PostgREST error, not something this app produces. It
 * means PostgREST could not query Postgres to (re)build its schema cache —
 * usually a brief blip right after a migration runs `notify pgrst, 'reload
 * schema'`, or the project waking up from being paused. It has nothing to do
 * with the credentials the user typed in, so it should never be shown as a
 * plain "login failed" message, and it is worth retrying automatically
 * before giving up.
 */

const RETRYABLE_PATTERNS = [
  /schema cache/i,
  /PGRST002/i,
  /failed to fetch/i,
  /network ?error/i,
  /fetch failed/i,
  /timed? ?out/i,
  /ECONNRESET/i,
  /503/,
];

export function isRetryableAuthError(message: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export function humanizeAuthError(message: string): string {
  const text = message.trim();
  if (!text) return 'Something went wrong. Please try again.';

  if (/schema cache|PGRST002/i.test(text)) {
    return 'The database is temporarily unavailable, so your account details could not be loaded. This is usually a brief Supabase hiccup (for example, right after a migration or the project waking back up) and clears up on its own within a minute or two. Tap Retry, or reload the page shortly.';
  }

  if (/failed to fetch|network ?error|fetch failed|ECONNRESET/i.test(text)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  return text;
}
