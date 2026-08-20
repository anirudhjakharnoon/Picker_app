// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// Chainable stub for supabase.from('profiles').select('*').eq('id', x).single()
const { single, getSession, onAuthStateChange, authCallbacks } = vi.hoisted(() => ({
  single: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  authCallbacks: [] as ((event: string, session: unknown) => void)[],
}));

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    // Mirrors the real chain: .from().select().eq().abortSignal().single()
    from: () => ({ select: () => ({ eq: () => ({ abortSignal: () => ({ single }) }) }) }),
    rpc: vi.fn(),
    auth: {
      getSession,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authCallbacks.push(cb);
        return onAuthStateChange(cb);
      },
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

import { AuthProvider } from './AuthProvider';
import { useAuth } from './AuthContext';

const SESSION = { user: { id: 'user-1' } };
const DB_DOWN = {
  data: null,
  error: { message: 'Could not query the database for the schema cache. Retrying.' },
};

function Probe() {
  const { autoRetryPaused, error, profile } = useAuth();
  return (
    <div>
      <span data-testid="paused">{String(autoRetryPaused)}</span>
      <span data-testid="error">{error ?? ''}</span>
      <span data-testid="profile">{profile ? 'loaded' : 'none'}</span>
    </div>
  );
}

/** Re-emits the session the way a token refresh or tab-focus does. */
function fireAuthEvent() {
  for (const cb of authCallbacks) cb('TOKEN_REFRESHED', SESSION);
}

describe('AuthProvider profile-load circuit breaker', () => {
  beforeEach(() => {
    single.mockReset();
    getSession.mockReset();
    onAuthStateChange.mockReset();
    authCallbacks.length = 0;
    getSession.mockResolvedValue({ data: { session: SESSION } });
    onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  // Without this, a provider from a finished test keeps its retry loop running
  // and keeps calling the shared mock - which is a neat miniature of the very
  // bug under test.
  afterEach(() => cleanup());

  it('stops issuing requests once repeated bursts have failed', async () => {
    // Every attempt fails the way a 503/PGRST002 does. The bug this encodes:
    // previously each auth event started a fresh retry burst with no limit
    // ACROSS bursts, producing ~5-6 requests/second for the same profile row
    // and over a million failed requests in under an hour on a down project.
    single.mockResolvedValue(DB_DOWN);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // First burst runs and fails; the breaker deliberately does not open yet,
    // since one bad burst can just be a blip.
    await waitFor(() => expect(screen.getByTestId('error').textContent).toMatch(/temporarily unavailable/i), {
      timeout: 10000,
    });

    // A second trigger (token refresh / focus) - this is what used to restart
    // the storm indefinitely. It should fail once more and then latch off.
    fireAuthEvent();
    await waitFor(() => expect(screen.getByTestId('paused').textContent).toBe('true'), { timeout: 10000 });

    const callsWhenPaused = single.mock.calls.length;

    // Hammer it with the events that previously each spawned a burst.
    for (let i = 0; i < 10; i += 1) fireAuthEvent();
    await new Promise((r) => setTimeout(r, 400));

    // The invariant: not one additional request.
    expect(single.mock.calls.length).toBe(callsWhenPaused);
  }, 30000);

  it('reports a non-retryable error immediately without any retry burst', async () => {
    // A genuine permission problem cannot be fixed by retrying, so it must cost
    // exactly one request and must not imply retries are pending.
    single.mockResolvedValue({ data: null, error: { message: 'permission denied for table profiles' } });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error').textContent).toMatch(/permission denied/i));
    expect(single.mock.calls.length).toBe(1);
    expect(screen.getByTestId('paused').textContent).toBe('false');
  });
});
