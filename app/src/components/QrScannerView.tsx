import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  /**
   * Called once per accepted decode. May be sync or async; the scanner awaits
   * the returned promise (if any) and only then accepts the NEXT scan. A
   * handler that shows an error and returns is perfectly safe — the scanner
   * always re-arms itself afterwards, so a wrong scan never freezes the camera.
   */
  onDecode: (value: string) => void | Promise<void>;
  /**
   * Hard gate: while true, decodes are ignored. Use it to freeze scanning
   * while a success screen is briefly shown before the parent unmounts/advances
   * the flow. This deliberately does NOT touch the camera MediaStream — see the
   * mount effect for why the stream is only ever acquired once per mount.
   */
  paused?: boolean;
  helperText?: string;
}

// A wrong QR left sitting in front of the camera decodes ~5x/sec. Without a
// guard, that machine-guns the decode handler (a flood of identical error
// toasts) and, for a shared order QR, risks double-counting. We accept a given
// value once, then ignore that SAME value until it clears the camera for this
// long. A DIFFERENT value is always accepted immediately, so scanning the next
// bag - or correcting a mis-scan - is never delayed.
const SAME_VALUE_COOLDOWN_MS = 1600;

/**
 * Thin wrapper around the `qr-scanner` library (MIT-licensed, no paid API,
 * runs entirely in the browser via getUserMedia - docs Section 19.6/10.6).
 *
 * Requires a secure context (HTTPS or localhost) and explicit camera
 * permission; both requirements are called out in the design doc's PWA
 * platform constraints (Section 10.6) and surfaced here as a specific error
 * message rather than a silent blank camera view.
 *
 * Reliability contract (this is what keeps the on-floor experience seamless):
 *   - The camera stream is created exactly ONCE per mount and never paused or
 *     restarted mid-life. Stopping/re-requesting getUserMedia between scans is
 *     what caused the "camera turns solid black and never recovers" bug on real
 *     devices, so we never do it.
 *   - A single in-flight decode is processed at a time. The processing lock is
 *     released in a `finally`, so it is IMPOSSIBLE for a handler that errors,
 *     early-returns, or throws to leave the scanner permanently stuck.
 *   - Duplicate reads of the same physical QR are debounced (see cooldown
 *     above) so a wrong code in-frame shows one clear error, not a loop.
 */
export function QrScannerView({ onDecode, paused = false, helperText }: QrScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  // Refs the decode callback reads so it always sees the CURRENT values. The
  // qr-scanner instance is built once and captures this callback once, so it
  // must not close over render-time props/state directly.
  const onDecodeRef = useRef(onDecode);
  const pausedRef = useRef(paused);
  const processingRef = useRef(false);
  const lastValueRef = useRef<{ value: string; at: number } | null>(null);
  onDecodeRef.current = onDecode;
  pausedRef.current = paused;

  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);

  const handleValue = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    // Ignore while a scan is being processed or the parent has paused us.
    if (processingRef.current || pausedRef.current) return;
    // Debounce repeated reads of the SAME code still sitting in frame.
    const now = Date.now();
    const last = lastValueRef.current;
    if (last && last.value === value && now - last.at < SAME_VALUE_COOLDOWN_MS) return;

    processingRef.current = true;
    lastValueRef.current = { value, at: now };
    try {
      await onDecodeRef.current(value);
    } finally {
      // Stamp the completion time so the cooldown is measured from when the
      // handler finished (covers a slow RPC), then always re-arm. This
      // `finally` is the single guarantee that the scanner can never wedge.
      lastValueRef.current = { value, at: Date.now() };
      processingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;

    if (!window.isSecureContext) {
      setError('Camera scanning requires HTTPS (or localhost). Use manual entry below instead.');
      return;
    }

    const scanner = new QrScanner(
      videoRef.current,
      (result) => void handleValue(typeof result === 'string' ? result : result.data),
      {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 5,
      },
    );
    scannerRef.current = scanner;

    scanner
      .start()
      .then(() => scanner.hasFlash())
      .then((hasFlash) => setTorchAvailable(hasFlash))
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? `Camera error: ${err.message}. You can use manual entry below instead.`
            : 'Camera unavailable. You can use manual entry below instead.',
        );
      });

    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [handleValue]);

  const toggleTorch = async () => {
    if (!scannerRef.current) return;
    try {
      if (torchOn) {
        await scannerRef.current.turnFlashOff();
      } else {
        await scannerRef.current.turnFlashOn();
      }
      setTorchOn((v) => !v);
    } catch {
      // Torch control is best-effort; some devices report flash then refuse it.
      setTorchAvailable(false);
    }
  };

  return (
    <div className="qr-scanner">
      <div className="qr-scanner-video-wrap">
        <video ref={videoRef} muted playsInline />
      </div>
      {helperText && <p className="qr-scanner-helper">{helperText}</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="qr-scanner-actions">
        {torchAvailable && (
          <button type="button" onClick={() => void toggleTorch()}>
            {torchOn ? 'Torch off' : 'Torch on'}
          </button>
        )}
        <button type="button" onClick={() => setShowManualEntry((v) => !v)}>
          {showManualEntry ? 'Hide manual entry' : "Can't scan? Enter code manually"}
        </button>
      </div>
      {showManualEntry && (
        <form
          className="qr-manual-entry"
          onSubmit={(e) => {
            e.preventDefault();
            const value = manualEntry.trim();
            if (value) {
              void handleValue(value);
              setManualEntry('');
            }
          }}
        >
          <input
            value={manualEntry}
            onChange={(e) => setManualEntry(e.target.value)}
            placeholder="Type the code printed under the QR"
          />
          <button type="submit">Submit</button>
        </form>
      )}
    </div>
  );
}
