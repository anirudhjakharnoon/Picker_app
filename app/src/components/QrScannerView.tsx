import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  onDecode: (value: string) => void;
  /**
   * Ignore new decodes while a scan is being processed (e.g. awaiting an
   * RPC). This deliberately does NOT call the underlying scanner's
   * pause()/start() — see the comment on the `[paused]` effect below for
   * why touching the camera stream itself is what caused the "camera turns
   * solid black and never recovers" bug on real devices.
   */
  paused?: boolean;
  helperText?: string;
}

/**
 * Thin wrapper around the `qr-scanner` library (MIT-licensed, no paid API,
 * runs entirely in the browser via getUserMedia — docs Section 19.6/10.6).
 *
 * Requires a secure context (HTTPS or localhost) and explicit camera
 * permission; both requirements are called out in the design doc's PWA
 * platform constraints (Section 10.6) and surfaced here as a specific error
 * message rather than a silent blank camera view.
 */
export function QrScannerView({ onDecode, paused = false, helperText }: QrScannerViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const decodeLockedRef = useRef(false);
  const onDecodeRef = useRef(onDecode);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);

  onDecodeRef.current = onDecode;

  const emitDecode = (value: string) => {
    // Camera libraries can decode the same visible QR several times before
    // React has committed the parent's `paused=true` render. With a shared
    // order QR, those duplicate callbacks incorrectly count as additional
    // physical bag scan actions. Lock synchronously inside the callback;
    // unlock only when the parent explicitly resumes scanning.
    if (decodeLockedRef.current || paused) return;
    decodeLockedRef.current = true;
    onDecodeRef.current(value);
  };

  useEffect(() => {
    if (!videoRef.current) return;

    if (!window.isSecureContext) {
      setError('Camera scanning requires HTTPS (or localhost). Use manual entry below instead.');
      return;
    }

    const scanner = new QrScanner(
      videoRef.current,
      (result) => emitDecode(typeof result === 'string' ? result : result.data),
      {
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 5,
      }
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
            : 'Camera unavailable. You can use manual entry below instead.'
        );
      });

    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // IMPORTANT: this deliberately never calls scanner.pause()/start().
    //
    // qr-scanner's pause() stops rendering the <video> element immediately,
    // but only stops the actual camera MediaStream after a 300ms grace
    // period (to avoid a permission-prompt flicker on a quick pause/resume).
    // Any real scan handler here awaits a network RPC before resuming —
    // almost always longer than 300ms — so every single scan was silently
    // hitting that deferred path: the camera stream got fully released,
    // and the following start() had to re-request getUserMedia from
    // scratch. On several real Android/iOS browser + OS combinations that
    // stop-then-immediately-reacquire cycle leaves the <video> rendering
    // solid black indefinitely with no error surfaced (this exact bug was
    // reported repeatedly for the hole/bag sorting scan flow, which chains
    // several scans in a row and so hits the flaky reacquire path harder).
    //
    // The camera only ever needs to be requested once per component
    // mount; "processing the last scan" only needs to gate the JS-level
    // decode callback, not the hardware camera stream itself.
    if (!paused) decodeLockedRef.current = false;
  }, [paused]);

  const toggleTorch = async () => {
    if (!scannerRef.current) return;
    if (torchOn) {
      await scannerRef.current.turnFlashOff();
    } else {
      await scannerRef.current.turnFlashOn();
    }
    setTorchOn(!torchOn);
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
          <button type="button" onClick={toggleTorch}>
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
            if (manualEntry.trim()) {
              emitDecode(manualEntry.trim());
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
