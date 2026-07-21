import { supabase } from './supabaseClient';
import { offlineDb, type PendingAction } from './offlineDb';

// Maps a queued action to its Supabase RPC name + argument shape.
// Keeping this mapping in one place means the offline queue and the "call it
// immediately while online" path (see submitAction below) never drift apart.
function rpcNameFor(type: PendingAction['type']): string {
  switch (type) {
    case 'accept_order':
      return 'accept_order_v1';
    case 'decline_order':
      return 'decline_order_v1';
    case 'set_picker_status':
      return 'set_picker_status_v1';
    case 'scan_bag_pickup':
      return 'scan_bag_pickup_v1';
    case 'scan_bag_for_sort':
      return 'scan_bag_for_sort_v1';
    case 'scan_pigeon_hole':
      return 'scan_pigeon_hole_v1';
    case 'record_warehouse_arrival':
      return 'record_warehouse_arrival_v1';
    case 'report_order_issue':
      return 'report_order_issue_v1';
  }
}

// Postgres/PostgREST error codes that mean "the server has definitively
// rejected this request" — retrying would loop forever for no benefit
// (docs Section 10.3). Anything else (network failure, timeout, 5xx) is
// treated as transient and retried with backoff.
const NON_RETRYABLE_CODES = new Set(['42501', '40001', 'P0002', '28000', '23505']);

export interface SyncResult {
  action: PendingAction;
  ok: boolean;
  data?: unknown;
  error?: string;
  retryable?: boolean;
}

let syncing = false;
const listeners = new Set<(results: SyncResult[]) => void>();

export function onSync(listener: (results: SyncResult[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Drains the pending action queue in creation order. Safe to call repeatedly
 * (e.g. on a timer, on `online` events, on tab focus) — it no-ops if a sync
 * is already running or the queue is empty.
 */
export async function trySyncNow(): Promise<SyncResult[]> {
  if (syncing) return [];
  if (!navigator.onLine) return [];
  syncing = true;
  const results: SyncResult[] = [];

  try {
    // Oldest first. Ordering matters for shared-QR pickup/sort scans: the
    // server assigns each accepted scan to the next logical bag slot, so
    // scans for the same order must reach it in the order they were captured.
    const pending = await offlineDb.pendingActions
      .where('status')
      .anyOf('pending', 'failed_permanent')
      .sortBy('id');

    for (const action of pending) {
      if (action.id === undefined) continue;
      await offlineDb.pendingActions.update(action.id, { status: 'syncing' });

      const rpcName = rpcNameFor(action.type);
      const { data, error } = await supabase.rpc(rpcName, action.payload);

      if (!error) {
        await offlineDb.pendingActions.delete(action.id);
        results.push({ action, ok: true, data });
        continue;
      }

      const code = (error as { code?: string }).code;
      const isNonRetryable = code !== undefined && NON_RETRYABLE_CODES.has(code);

      if (isNonRetryable) {
        // The server has spoken: this specific action can never succeed as
        // written (e.g. order no longer assigned to this picker, expected
        // bag count already reached). Remove it and surface the reason.
        await offlineDb.pendingActions.delete(action.id);
        results.push({ action, ok: false, error: error.message, retryable: false });
      } else {
        await offlineDb.pendingActions.update(action.id, {
          status: 'pending',
          attempts: action.attempts + 1,
          lastError: error.message,
        });
        results.push({ action, ok: false, error: error.message, retryable: true });
        // Stop draining on the first transient failure for THIS order's
        // scan sequence rather than hammering an unreachable server with
        // the rest of the queue; the next timer tick will retry from here.
        break;
      }
    }
  } finally {
    syncing = false;
  }

  if (results.length > 0) {
    listeners.forEach((l) => l(results));
  }
  return results;
}

let started = false;

/** Wire up the timer + browser event listeners exactly once per app session. */
export function startSyncEngine(intervalMs = 15000): () => void {
  if (started) return () => undefined;
  started = true;

  const interval = window.setInterval(() => {
    void trySyncNow();
  }, intervalMs);

  const onOnline = () => void trySyncNow();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void trySyncNow();
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  void trySyncNow();

  return () => {
    window.clearInterval(interval);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    started = false;
  };
}

export async function pendingActionCount(): Promise<number> {
  return offlineDb.pendingActions.count();
}
