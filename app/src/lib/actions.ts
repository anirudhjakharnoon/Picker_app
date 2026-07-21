import { enqueueAction, newClientEventId, type PendingActionType } from './offlineDb';
import { onSync, trySyncNow, type SyncResult } from './syncEngine';

export interface SubmitHandle {
  /** The client-generated event id this specific call used (stable identity
   * for idempotency and for matching a later `onSync` result). */
  localId: string;
  /** Resolves once the sync engine has processed this exact action — either
   * with its result, or `null` if we're offline / it hasn't settled within
   * the timeout. Awaiting this is appropriate when the caller genuinely
   * needs the server's answer (e.g. a scan result, which decides the next
   * screen) — never await it just to "unlock" a button, since that is
   * exactly what makes taps feel unresponsive on a slow connection. */
  settled: Promise<SyncResult | null>;
}

/**
 * Queue-first action submission used by every Picker-tab mutation.
 *
 * The action is written to the durable local queue FIRST, before any network
 * attempt (docs Section 10.2). This function itself resolves as soon as that
 * local write completes (near-instant IndexedDB write) — it does NOT wait for
 * the network round trip. Callers that want optimistic, instantly-responsive
 * buttons should update their UI right after `submitAction()` resolves and
 * only use `settled` to reconcile/rollback later. Callers that need the
 * server's answer before they can proceed (e.g. a scan) should `await
 * handle.settled`.
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
): Promise<SubmitHandle> {
  const localId = newClientEventId();
  const payload = buildPayload(localId);
  const dexieId = await enqueueAction(type, payload, localId, clientCapturedAt);

  // Kick the drain off in the background regardless of whether the caller
  // awaits `settled` — this is what makes the common "online" path still
  // resolve quickly for callers that DO await it, without making callers who
  // don't await it block on anything.
  if (navigator.onLine) void trySyncNow();

  const settled = navigator.onLine ? waitForActionResult(dexieId, 30_000) : Promise.resolve(null);

  return { localId, settled };
}

function waitForActionResult(dexieId: number, timeoutMs: number): Promise<SyncResult | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: SyncResult | null) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      globalThis.clearInterval(retryTimer);
      globalThis.clearTimeout(timeout);
      resolve(result);
    };

    const unsubscribe = onSync((results) => {
      const match = results.find((result) => result.action.id === dexieId);
      if (match) finish(match);
    });

    // If another drain is active, this first call returns immediately; the
    // interval retries as soon as it finishes. Calls are safe because the
    // sync engine itself has a single-flight guard.
    const retryTimer = globalThis.setInterval(() => {
      void trySyncNow();
    }, 150);
    const timeout = globalThis.setTimeout(() => finish(null), timeoutMs);

    void trySyncNow();
  });
}
