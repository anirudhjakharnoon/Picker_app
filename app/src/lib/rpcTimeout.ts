// Guards against a hung network request wedging the UI. A Supabase RPC that
// never settles (flaky mobile network, upstream stall) would otherwise leave a
// scan handler awaiting forever and freeze the scanner. Racing every scan RPC
// against a timeout turns that into a normal, retryable error.
//
// The budget is deliberately generous: a picker on mall Wi-Fi hitting a
// free-tier instance that has just gone cold can legitimately take several
// seconds, and reporting "took too long" for a request that then succeeds is
// worse than waiting. Callers that pass a stable `p_client_event_id` (see
// submitAction) retry once on timeout, which is safe because the scan RPCs are
// idempotent on that id.
export const RPC_TIMEOUT_MS = 20000;

/** Thrown when the timeout wins the race, so callers can retry only on timeout. */
export class RpcTimeoutError extends Error {
  constructor(ms: number) {
    super('The server took too long to respond. Please try again.');
    this.name = 'RpcTimeoutError';
    this.timeoutMs = ms;
  }

  readonly timeoutMs: number;
}

export function isRpcTimeout(err: unknown): boolean {
  return err instanceof RpcTimeoutError;
}

export function withTimeout<T>(promise: PromiseLike<T>, ms: number = RPC_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(ms)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Like withTimeout, but it ACTUALLY CANCELS the request when the timeout wins.
 *
 * withTimeout alone only abandons the promise: the underlying fetch keeps
 * running, so the server never learns the caller gave up. For a Supabase RPC
 * that means PostgREST can be left mid-transaction on a pooled connection.
 * Session state pulled from the live project showed 6 connections stuck in
 * `idle in transaction (aborted)` and 2 more in `idle in transaction`, all of
 * them PostgREST RPC calls — 8 of 16 slots held by transactions nobody was
 * waiting for any more. Once the pool is starved, PostgREST cannot get a
 * connection to load its schema cache, so every REST request returns
 * PGRST002/PGRST003 while the database itself stays perfectly healthy (which
 * is exactly what the project dashboard reported).
 *
 * Passing the signal into `.abortSignal()` makes the client close the HTTP
 * request on timeout, so PostgREST sees the disconnect and can release the
 * connection instead of stranding it.
 *
 * @param build receives the signal and must attach it, e.g.
 *   `withAbortTimeout((signal) => supabase.rpc('f', args).abortSignal(signal))`
 */
export function withAbortTimeout<T>(
  build: (signal: AbortSignal) => PromiseLike<T>,
  ms: number = RPC_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new RpcTimeoutError(ms));
    }, ms);
    Promise.resolve(build(controller.signal)).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
