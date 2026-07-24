// @vitest-environment jsdom
// Models the REAL picker handler shape after removing the `paused` round-trip:
// an async handler that shows an error for a wrong code and advances on the
// correct one, with no external lock. Guards against the "wrong QR then correct
// QR gets stuck" regression at the parent<->scanner boundary.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { act, useState } from 'react';
import { QrScannerView } from './QrScannerView';

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
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

async function frame(value: string) {
  await act(async () => {
    decodeCb?.({ data: value });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Stand-in for the real handlers: awaits an "RPC", rejects the wrong code with
// an error toast (state update), accepts the right one. Crucially there is NO
// paused/lock state feeding back into the scanner.
function Harness({ onAccepted }: { onAccepted: (v: string) => void }) {
  const [errors, setErrors] = useState(0);

  const handleDecode = async (value: string) => {
    await Promise.resolve(); // awaited RPC
    if (value !== 'RIGHT') {
      setErrors((n) => n + 1); // "notify(error)" — a real state update
      return;
    }
    onAccepted(value);
  };

  return (
    <>
      <span data-testid="errors">{errors}</span>
      <QrScannerView onDecode={handleDecode} />
    </>
  );
}

describe('parent <-> scanner: retry after wrong scan', () => {
  it('processes the correct code after a wrong code', async () => {
    const accepted: string[] = [];
    render(<Harness onAccepted={(v) => accepted.push(v)} />);

    await frame('WRONG'); // rejected
    await frame('WRONG'); // debounced (same code in-frame)
    await frame('RIGHT'); // must be accepted

    expect(accepted).toEqual(['RIGHT']);
    cleanup();
  });

  it('recovers even if several different wrong codes are tried first', async () => {
    const accepted: string[] = [];
    render(<Harness onAccepted={(v) => accepted.push(v)} />);

    await frame('WRONG-A');
    await frame('WRONG-B');
    await frame('WRONG-C');
    await frame('RIGHT');

    expect(accepted).toEqual(['RIGHT']);
    cleanup();
  });
});

// Models the two bag-scan journeys at the scanner->handler layer (the same
// path the camera and the manual-entry fallback both feed).
describe('bag-scan journeys', () => {
  it('multi-bag: accepts each distinct bag exactly once, in order', async () => {
    const scanned = [];
    const onDecode = async (v) => {
      await Promise.resolve();
      scanned.push(v);
    };
    render(<QrScannerView onDecode={onDecode} />);

    // Each bag decodes for a few frames while it sits in front of the camera.
    for (const bag of ['BAG-1', 'BAG-2', 'BAG-3', 'BAG-4', 'BAG-5']) {
      await frame(bag);
      await frame(bag); // duplicate frames of the same bag must NOT double-count
    }

    expect(scanned).toEqual(['BAG-1', 'BAG-2', 'BAG-3', 'BAG-4', 'BAG-5']);
    cleanup();
  });

  it('single-bag: one physical bag confirms the shipment once', async () => {
    let confirms = 0;
    const onDecode = async () => {
      await Promise.resolve();
      confirms += 1;
    };
    render(<QrScannerView onDecode={onDecode} />);

    // The one bag lingers in frame for several decode frames.
    await frame('THE-ONE-BAG');
    await frame('THE-ONE-BAG');
    await frame('THE-ONE-BAG');

    expect(confirms).toBe(1);
    cleanup();
  });
});
