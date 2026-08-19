import { describe, expect, it } from 'vitest';
import { isRpcTimeout, RpcTimeoutError, withTimeout } from './rpcTimeout';

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
