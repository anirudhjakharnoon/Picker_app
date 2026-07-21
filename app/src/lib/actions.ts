import { enqueueAction, newClientEventId, type PendingActionType } from './offlineDb';
import { trySyncNow, type SyncResult } from './syncEngine';

/**
 * Queue-first action submission used by every Picker-tab mutation.
 *
 * The action is written to the durable local queue FIRST, before any network
 * attempt (docs Section 10.2) — the UI can treat this call's return value as
 * "queued" immediately, whether or not it happens to resolve right away
 * below. If the device is online, we opportunistically drain the queue so
 * the common case still feels instant.
 *
 * `buildPayload` receives a freshly generated client event id so callers can
 * include it as `p_client_event_id` for the scan/arrival RPCs that require it
 * for server-side idempotency (docs Section 5.3.5) — RPCs that take no such
 * parameter (accept_order_v1, decline_order_v1, set_picker_status_v1,
 * report_order_issue_v1) simply omit it from the payload they return.
 */
export async function submitAction(
  type: PendingActionType,
  buildPayload: (clientEventId: string) => Record<string, unknown>,
  clientCapturedAt: string = new Date().toISOString()
): Promise<{ localId: string; immediate: SyncResult | null }> {
  const localId = newClientEventId();
  const payload = buildPayload(localId);

  const dexieId = await enqueueAction(type, payload, localId, clientCapturedAt);

  if (!navigator.onLine) {
    return { localId, immediate: null };
  }

  const results = await trySyncNow();
  const immediate = results.find((r) => r.action.id === dexieId) ?? null;
  return { localId, immediate };
}
