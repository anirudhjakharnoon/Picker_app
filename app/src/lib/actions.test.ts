import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Set<(results: unknown[]) => void>();
  return {
    listeners,
    enqueueAction: vi.fn(async () => 42),
    newClientEventId: vi.fn(() => 'warehouse-event-id'),
    trySyncNow: vi.fn(async () => []),
  };
});

vi.mock('./offlineDb', () => ({
  enqueueAction: mocks.enqueueAction,
  newClientEventId: mocks.newClientEventId,
}));

vi.mock('./syncEngine', () => ({
  trySyncNow: mocks.trySyncNow,
  onSync: (listener: (results: unknown[]) => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  },
}));

import { submitAction } from './actions';

describe('submitAction sync contention regression', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.enqueueAction.mockClear();
    mocks.newClientEventId.mockClear();
    mocks.trySyncNow.mockClear();
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('waits for its exact queued warehouse action when another drain is already active', async () => {
    const handle = await submitAction('record_warehouse_arrival', (eventId) => ({
      p_client_event_id: eventId,
      p_order_ids: ['order-1'],
      p_gate_qr_value: 'GATE-1',
    }));

    expect(handle.localId).toBe('warehouse-event-id');

    // Simulate the sync engine finishing a pre-existing drain, then emitting
    // the result for the newly queued row on the retry initiated by
    // waitForActionResult. Before the original regression fix, submitAction
    // resolved with a null result as soon as the first no-op drain returned.
    globalThis.setTimeout(() => {
      const syncResult = {
        action: {
          id: 42,
          type: 'record_warehouse_arrival',
          clientEventId: 'warehouse-event-id',
          payload: {},
          createdAt: new Date().toISOString(),
          attempts: 0,
          status: 'pending',
        },
        ok: true,
        data: [{ order_id: 'order-1', pigeon_hole_number: 'P-001', reserved: true }],
      };
      mocks.listeners.forEach((listener) => listener([syncResult]));
    }, 20);

    const result = await handle.settled;

    expect(result?.ok).toBe(true);
    expect(result?.data).toEqual([
      { order_id: 'order-1', pigeon_hole_number: 'P-001', reserved: true },
    ]);
    expect(mocks.listeners.size).toBe(0);
  });

  it('resolves immediately (queued) without waiting for the network', async () => {
    // This is the core "buttons must respond instantly" contract: callers
    // that only need to know the action was durably queued (to update
    // optimistic UI) must not be blocked on the network round trip.
    const start = Date.now();
    const handle = await submitAction('set_picker_status', () => ({ p_is_online: true }));
    expect(Date.now() - start).toBeLessThan(100);
    expect(handle.localId).toBe('warehouse-event-id');
    expect(handle.settled).toBeInstanceOf(Promise);
  });
});
