import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCodePreview({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, {
      width: 160,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#141416', light: '#ffffff' },
    }).then((next) => {
      if (!cancelled) setSrc(next);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  return src ? <img className="qr-code-preview" src={src} alt={`Scannable QR code for ${label}`} /> : null;
}
