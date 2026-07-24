// @vitest-environment jsdom
// Reproduction harness for the "wrong QR then correct QR gets stuck" report.
// Mocks the qr-scanner library so we can drive the decode callback exactly the
// way the real camera loop does (it fires continuously, every frame a code is
// visible), and assert the component keeps trying new codes.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { act } from 'react';
import { QrScannerView } from './QrScannerView';

// Capture the decode callback the component hands to `new QrScanner(...)`.
let decodeCb: ((result: { data: string }) => void) | null = null;

vi.mock('qr-scanner', () => {
  class FakeQrScanner {
    constructor(_video: unknown, cb: (result: { data: string }) => void) {
      decodeCb = cb;
    }
    start() {
      return Promise.resolve();
    }
    hasFlash() {
      return Promise.resolve(false);
    }
    stop() {}
    destroy() {
      decodeCb = null;
    }
    turnFlashOn() {
      return Promise.resolve();
    }
    turnFlashOff() {
      return Promise.resolve();
    }
  }
  return { default: FakeQrScanner };
});

beforeEach(() => {
  decodeCb = null;
  vi.useRealTimers();
  // jsdom defaults isSecureContext to false, which would make the component
  // short-circuit to its "needs HTTPS" branch and never build the scanner.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

// Simulate one camera frame delivering a decoded value, then let microtasks
// (the awaited async handler) flush.
async function frame(value: string) {
  await act(async () => {
    decodeCb?.({ data: value });
    // flush the handler's promise chain
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('QrScannerView - watchdog re-arms after a hung handler', () => {
  it('does not stay stuck if a decode handler never settles', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const onDecode = (v: string) => {
      seen.push(v);
      // Simulate a hung RPC: the first scan's promise never resolves.
      return v === 'HANG' ? new Promise<void>(() => {}) : Promise.resolve();
    };
    render(<QrScannerView onDecode={onDecode} />);

    // First scan hangs and locks the scanner.
    act(() => decodeCb?.({ data: 'HANG' }));
    expect(seen).toEqual(['HANG']);

    // While hung, a different code is ignored (one decode at a time).
    act(() => decodeCb?.({ data: 'NEXT' }));
    expect(seen).toEqual(['HANG']);

    // After the watchdog fires, the scanner re-arms and the next code works.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13001);
    });
    await act(async () => {
      decodeCb?.({ data: 'NEXT' });
      await Promise.resolve();
    });
    expect(seen).toContain('NEXT');

    vi.useRealTimers();
    cleanup();
  });
});

describe('QrScannerView - iOS camera element setup', () => {
  it('forces the muted property + inline attributes so iOS renders the stream', () => {
    const { container } = render(<QrScannerView onDecode={() => {}} />);
    const video = container.querySelector('video');
    if (!video) throw new Error('video element not rendered');
    // React's JSX `muted` attribute does not reliably set the property; the
    // component must set it on the DOM node or iOS shows a black camera.
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(true);
    cleanup();
  });
});

describe('QrScannerView - retry after a wrong scan', () => {
  it('processes a correct code after a wrong code (no stuck lock)', async () => {
    const seen: string[] = [];
    // Handler mirrors the real ones: does async work, "rejects" a wrong code by
    // simply returning (an error toast in the real app), resolves either way.
    const onDecode = vi.fn(async (value: string) => {
      seen.push(value);
      await Promise.resolve();
    });

    render(<QrScannerView onDecode={onDecode} />);
    expect(decodeCb).toBeTypeOf('function');

    // Wrong code sitting in frame for several frames, then the correct code.
    await frame('WRONG');
    await frame('WRONG'); // same value in-frame: must be debounced, not re-run
    await frame('WRONG');
    await frame('RIGHT');

    expect(seen).toContain('RIGHT');
    // WRONG processed once (debounced), RIGHT processed once.
    expect(seen.filter((v) => v === 'WRONG')).toHaveLength(1);
    expect(seen.filter((v) => v === 'RIGHT')).toHaveLength(1);
    cleanup();
  });

  it('keeps accepting alternating distinct codes', async () => {
    const seen: string[] = [];
    const onDecode = vi.fn(async (value: string) => {
      seen.push(value);
      await Promise.resolve();
    });
    render(<QrScannerView onDecode={onDecode} />);

    await frame('A');
    await frame('B');
    await frame('A'); // distinct from the immediately-previous B, but within A's cooldown
    await frame('C');

    // A (1st), B, C must all be processed; the 2nd A may be cooled down.
    expect(seen).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    cleanup();
  });
});
