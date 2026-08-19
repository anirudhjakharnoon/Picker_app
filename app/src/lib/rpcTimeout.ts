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
