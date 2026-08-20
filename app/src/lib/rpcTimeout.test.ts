import { describe, expect, it } from 'vitest';
import { isRpcTimeout, RpcTimeoutError, withAbortTimeout, withTimeout } from './rpcTimeout';

describe('withAbortTimeout', () => {
  it('aborts the signal when the timeout wins, so the request is really cancelled', async () => {
    // The whole point: withTimeout alone abandons the promise but leaves the
    // fetch running, which can strand a PostgREST transaction on a pooled
    // connection. Live session state showed 8 of 16 connections held that way.
    let seen: AbortSignal | undefined;
    const pending = withAbortTimeout((signal) => {
      seen = signal;
      return new Promise<string>(() => {}); // never settles
    }, 10);

    await expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it('does not abort when the request wins the race', async () => {
    let seen: AbortSignal | undefined;
    const value = await withAbortTimeout((signal) => {
      seen = signal;
      return Promise.resolve('ok');
    }, 1000);

    expect(value).toBe('ok');
    expect(seen?.aborted).toBe(false);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with an identifiable RpcTimeoutError when the timeout wins', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10)).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it('passes a rejection through unchanged rather than reporting a timeout', async () => {
    const boom = new Error('Wrong bag - this bag does not belong to this shipment');
    await expect(withTimeout(Promise.reject(boom), 50)).rejects.toBe(boom);
  });
});

describe('isRpcTimeout', () => {
  // submitAction retries ONLY on timeout, so this predicate is what keeps a real
  // rejection (wrong bag, hole occupied, not permitted) from being replayed.
  it('identifies timeouts and nothing else', () => {
    expect(isRpcTimeout(new RpcTimeoutError(20000))).toBe(true);
    expect(isRpcTimeout(new Error('The server took too long to respond. Please try again.'))).toBe(false);
    expect(isRpcTimeout(new Error('Wrong bag'))).toBe(false);
    expect(isRpcTimeout(null)).toBe(false);
    expect(isRpcTimeout('timeout')).toBe(false);
  });
});
