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
    const resultPromise = submitAction('record_warehouse_arrival', (eventId) => ({
      p_client_event_id: eventId,
      p_order_ids: ['order-1'],
      p_gate_qr_value: 'GATE-1',
    }));

    // Simulate the sync engine finishing a pre-existing drain, then emitting
    // the result for the newly queued row on the retry initiated by
    // waitForActionResult. Before this regression fix, submitAction returned
    // immediate:null as soon as the first no-op drain returned.
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

    const result = await resultPromise;

    expect(result.localId).toBe('warehouse-event-id');
    expect(result.immediate?.ok).toBe(true);
    expect(result.immediate?.data).toEqual([
      { order_id: 'order-1', pigeon_hole_number: 'P-001', reserved: true },
    ]);
    expect(mocks.listeners.size).toBe(0);
  });
});
