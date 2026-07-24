import { useCallback, useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  /**
   * Called once per accepted decode. May be sync or async; the scanner awaits
   * the returned promise (if any) and only then accepts the NEXT scan. A
   * handler that shows an error and returns is completely safe - the scanner
   * always re-arms itself afterwards, so a wrong scan never freezes the camera.
   *
   * There is deliberately NO `paused`/lock prop. The scanner is the single
   * owner of "am I mid-scan"; callers do not gate it with their own state,
   * because a caller's async state (set-true-before-await, set-false-after)
   * used to feed back in and drop the very next code on a stale render - which
   * is exactly the "wrong QR then correct QR gets stuck" bug. To stop scanning,
   * a caller simply stops rendering this component (advances to a success
   * screen), which every flow already does.
   */
  onDecode: (value: string) => void | Promise<void>;
  helperText?: string;
}

// A code sitting in front of the camera decodes continuously (~5x/sec). We
// accept a given value once, then ignore that SAME value for this long so a
// wrong code shows ONE clear error instead of a flood, and a shared bag QR is
// never double-counted. A DIFFERENT value is always accepted immediately, so
// correcting a mis-scan - the exact retry the user needs - is instant.
const SAME_VALUE_COOLDOWN_MS = 1200;

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
 *   - Exactly one decode is processed at a time. The processing flag is cleared
 *     in a `finally`, so a handler that errors, early-returns, or throws can
 *     NEVER leave the scanner stuck.
 *   - Every frame is matched. A wrong code produces one error and the scanner
 *     immediately keeps scanning; the moment a different (correct) code appears
 *     it is used. No external pause state can drop that next code.
 */
export function QrScannerView({ onDecode, helperText }: QrScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  // Refs the decode callback reads so it always sees CURRENT values. The
  // qr-scanner instance is built once and captures this callback once, so it
  // must not close over render-time props/state directly.
  const onDecodeRef = useRef(onDecode);
  const processingRef = useRef(false);
  const lastValueRef = useRef<{ value: string; at: number } | null>(null);
  onDecodeRef.current = onDecode;

  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);

  const handleValue = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    // One decode at a time.
    if (processingRef.current) return;
    // Debounce repeated reads of the SAME code still sitting in frame; a
    // different code always passes so the corrective re-scan is never delayed.
    const now = Date.now();
    const last = lastValueRef.current;
    if (last && last.value === value && now - last.at < SAME_VALUE_COOLDOWN_MS) return;

    processingRef.current = true;
    lastValueRef.current = { value, at: now };
    try {
      await onDecodeRef.current(value);
    } finally {
      // Stamp completion time (covers a slow RPC) and always re-arm. This
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

    const video = videoRef.current;
    // iOS Safari will only play a camera stream INLINE and without a user
    // gesture when the element is genuinely muted + playsinline. React's JSX
    // `muted` attribute does NOT reliably set the underlying muted PROPERTY, so
    // an un-muted element leaves the camera a solid black rectangle on iOS.
    // Force the property and the inline attributes on the real DOM node.
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');

    const scanner = new QrScanner(
      video,
      (result) => void handleValue(typeof result === 'string' ? result : result.data),
      {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 5,
        // Pickers scan with the rear camera; be explicit so iOS doesn't pick
        // the front one (which also reads as a black/unhelpful preview).
        preferredCamera: 'environment',
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
        <video ref={videoRef} muted autoPlay playsInline disablePictureInPicture />
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
