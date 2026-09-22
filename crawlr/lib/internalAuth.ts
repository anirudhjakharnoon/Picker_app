/**
 * Shared-secret check for internal, server-to-server-only endpoints (the
 * tick worker and both cron routes). None of these should ever be callable
 * directly by a browser: tick is kicked off by POST /api/jobs and by its
 * own self-fetch continuation; watchdog/cleanup are invoked by Vercel Cron,
 * which automatically sends `Authorization: Bearer $CRON_SECRET` on every
 * cron request once that env var is set (a built-in Vercel behavior - no
 * extra plumbing needed for the cron side).
 */

export function isAuthorizedInternalRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: without a configured secret, nobody can call these
    // internal routes at all (safer default than accepting every caller
    // just because local dev forgot to set the env var).
    return false;
  }
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export function internalAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
