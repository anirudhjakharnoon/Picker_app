import { describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabaseClient', () => ({
  supabase: { rpc },
}));

import { submitAction } from './actions';

describe('online-only action submission', () => {
  it('calls the scan RPC directly and preserves a generated idempotency id', async () => {
    rpc.mockResolvedValueOnce({ data: { scanned: 1 }, error: null });
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
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'network unavailable' } });
    await expect(submitAction('accept_order', () => ({ p_order_id: 'order-1' }))).resolves.toMatchObject({
      ok: false,
      error: 'network unavailable',
    });
  });
});
