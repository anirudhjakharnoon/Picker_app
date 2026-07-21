import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { supabase } from '../lib/supabaseClient';
import type { QrCode, Warehouse } from '../types/database';

/**
 * Shows the server-authoritative, rotating warehouse gate QR. The RPC lazily
 * creates a fresh code when the hourly window rolls over; the client checks
 * just after that boundary and renders an actual scannable image, rather than
 * exposing only a text value.
 */
export function WarehouseGateQr({ warehouse }: { warehouse: Warehouse }) {
  const [qr, setQr] = useState<QrCode | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error: rpcError } = await supabase.rpc('get_active_warehouse_gate_qr_v1', {
        p_warehouse_id: warehouse.id,
      });
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      const code = data as QrCode;
      setQr(code);
      try {
        const url = await QRCode.toDataURL(code.code_value, {
          width: 280,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#141416', light: '#ffffff' },
        });
        if (!cancelled) setImage(url);
      } catch {
        if (!cancelled) setError('Could not render warehouse QR code.');
      }
    };

    void load();
    // Refresh every minute so a display that stays open renews promptly at the
    // next server-side hourly expiry boundary. This is one lightweight RPC per
    // displayed screen per minute—not a high-frequency table poll.
    const refresh = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [warehouse.id]);

  const expiresAt = qr?.expires_at ? new Date(qr.expires_at) : null;
  return (
    <section className="warehouse-qr">
      <div>
        <span className="panel-eyebrow">Warehouse gate</span>
        <h2>{warehouse.name} QR code</h2>
        <p>Pickers scan this code when they arrive at the warehouse. It refreshes automatically every hour.</p>
      </div>
      {error && <p className="error-text">{error}</p>}
      {image && qr && (
        <div className="warehouse-qr-code">
          <img src={image} alt={`Scannable warehouse gate QR for ${warehouse.name}`} />
          <code>{qr.code_value}</code>
          {expiresAt && <span>Refreshes at {expiresAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
      )}
    </section>
  );
}
