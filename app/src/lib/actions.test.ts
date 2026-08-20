import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabaseClient', () => ({
  supabase: { rpc },
}));

import { submitAction } from './actions';

/**
 * submitAction now calls `supabase.rpc(...).abortSignal(signal)` so a timed-out
 * request is genuinely cancelled rather than left running (an abandoned request
 * can strand a PostgREST transaction on a pooled connection). These helpers
 * shape the mock like that real chain.
 */
function resolving(value: unknown) {
  return { abortSignal: () => Promise.resolve(value) };
}
function neverSettling() {
  return { abortSignal: () => new Promise(() => {}) };
}

describe('online-only action submission', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('calls the scan RPC directly and preserves a generated idempotency id', async () => {
    rpc.mockReturnValueOnce(resolving({ data: { scanned: 1 }, error: null }));
    const result = await submitAction('scan_bag_pickup', (eventId) => ({
      p_client_event_id: eventId,
      p_order_id: 'order-1',
    }));

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ scanned: 1 });
    expect(rpc).toHaveBeenCalledWith(
      'scan_bag_pickup_v1',
      expect.objectContaining({ p_client_event_id: result.localId, p_order_id: 'order-1' })
    );
  });

  it('returns an actionable server error rather than queueing offline work', async () => {
    rpc.mockReturnValueOnce(resolving({ data: null, error: { message: 'network unavailable' } }));
    await expect(submitAction('accept_order', () => ({ p_order_id: 'order-1' }))).resolves.toMatchObject({
      ok: false,
      error: 'network unavailable',
    });
  });

  it('does NOT retry a normal server rejection (e.g. a wall mismatch)', async () => {
    // supabase-js resolves RPC-level errors (bad input, a raised exception) as a
    // normal { error } response, not a thrown rejection - only a client-side
    // timeout throws. A validation error like a wall mismatch must return
    // immediately: retrying it would just repeat the same rejected write.
    rpc.mockReturnValueOnce(
      resolving({
        data: null,
        error: { message: 'This hole is on the Hyperlocal wall. Use a LMS hole for this shipment.' },
      }),
    );
    const result = await submitAction('scan_bag_into_held_hole', (eventId) => ({ p_client_event_id: eventId }));
    expect(result.ok).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('retries once on a client-side timeout, reusing the same client event id', async () => {
    // First call hangs forever (simulating a dropped connection); the fake
    // timer advances past withTimeout's 20s budget so the retry fires without
    // this test actually waiting 20 real seconds. The retry (second call)
    // resolves normally. Both calls must carry the SAME p_client_event_id -
    // that is what makes the retry an idempotent replay on the server rather
    // than a second scan (verified against the real RPC while building this;
    // see rpcTimeout.test.ts for the timeout classifier this depends on).
    vi.useFakeTimers();
    try {
      rpc
        .mockImplementationOnce(() => neverSettling()) // never settles: timeout wins
        .mockReturnValueOnce(resolving({ data: { dropped: 1 }, error: null }));

      const resultPromise = submitAction('scan_bag_into_held_hole', (eventId) => ({
        p_client_event_id: eventId,
        p_bag_qr_value: 'BAG-1',
      }));

      await vi.advanceTimersByTimeAsync(20000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(2);
      const firstCallEventId = rpc.mock.calls[0][1].p_client_event_id;
      const secondCallEventId = rpc.mock.calls[1][1].p_client_event_id;
      expect(firstCallEventId).toBe(secondCallEventId);
      expect(firstCallEventId).toBe(result.localId);
    } finally {
      vi.useRealTimers();
    }
  });
});
