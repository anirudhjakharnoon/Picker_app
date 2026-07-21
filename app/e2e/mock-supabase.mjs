// Lightweight Supabase mocking helpers for the e2e smoke test. These exist
// because this project has no real Supabase credentials available in CI/dev
// containers, but the interaction bugs worth catching (a stuck optimistic
// toggle, a fixed bottom bar covering a button, `e.currentTarget` going null
// after an `await`, an RPC schema-cache mismatch) only show up once the app
// actually renders a logged-in screen with real-shaped data — a plain
// unit test with jsdom would not have caught any of them.
export function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

export const SUPABASE_HOST = 'aetrwtubfifljkxwocpy.supabase.co';

export function makeSession(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt({ sub: userId, role: 'authenticated', exp: now + 3600, email }),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'fake-refresh-token',
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

export async function seedSession(page, session) {
  await page.addInitScript((s) => {
    window.localStorage.setItem(`sb-${'aetrwtubfifljkxwocpy'}-auth-token`, JSON.stringify(s));
  }, session);
}

/**
 * Installs a route handler that answers every Supabase call for the
 * duration of the test. `handlers` is a list of `[predicate, responder]`
 * pairs checked in order; the first match wins. Realtime websocket upgrades
 * are aborted (the app treats Realtime as a pure acceleration layer on top
 * of polling/refetch, per the design doc, so this is a safe no-op in tests).
 */
export async function installSupabaseMock(page, handlers) {
  await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
    const url = route.request().url();
    if (url.startsWith('wss://') || url.includes('/realtime/')) {
      return route.abort();
    }
    for (const [predicate, respond] of handlers) {
      if (predicate(url, route.request())) {
        return respond(route);
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

export function jsonRoute(status, body) {
  return (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
