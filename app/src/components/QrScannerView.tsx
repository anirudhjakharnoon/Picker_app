import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';

interface QrScannerViewProps {
  onDecode: (value: string) => void;
  /** Disable scanning (e.g. while a scan is being processed) without tearing
   * down the camera — avoids the camera-permission re-prompt flicker. */
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
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);

  useEffect(() => {
    if (!videoRef.current) return;

    if (!window.isSecureContext) {
      setError('Camera scanning requires HTTPS (or localhost). Use manual entry below instead.');
      return;
    }

    const scanner = new QrScanner(
      videoRef.current,
      (result) => onDecode(typeof result === 'string' ? result : result.data),
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
    if (!scannerRef.current) return;
    if (paused) {
      scannerRef.current.pause();
    } else {
      void scannerRef.current.start();
    }
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
              onDecode(manualEntry.trim());
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
