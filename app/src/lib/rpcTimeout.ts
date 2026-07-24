// Guards against a hung network request wedging the UI. A Supabase RPC that
// never settles (flaky mobile network, upstream stall) would otherwise leave a
// scan handler awaiting forever and freeze the scanner. Racing every scan RPC
// against a timeout turns that into a normal, retryable error.
export const RPC_TIMEOUT_MS = 12000;

export function withTimeout<T>(promise: PromiseLike<T>, ms: number = RPC_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The server took too long to respond. Please try again.')),
      ms,
    );
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
