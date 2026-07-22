import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { supabase } from '../lib/supabaseClient';
import type { QrCode, Warehouse } from '../types/database';

/**
 * Shows the server-authoritative, rotating warehouse gate QR. The RPC lazily
 * creates a fresh code when the hourly window rolls over; the client checks
 * just after that boundary and renders an actual scannable image, rather than
 * exposing only a text value.
 *
 * A live countdown makes expiry unmissable: because the code is only re-polled
 * periodically, there used to be a window where a displayed code was already
 * expired but looked perfectly valid, so a picker would scan it and be rejected
 * at the gate. Now the code visibly warns in its last minute and dims + reloads
 * itself the moment it expires.
 */
export function WarehouseGateQr({ warehouse }: { warehouse: Warehouse }) {
  const [qr, setQr] = useState<QrCode | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reloadingRef = useRef(false);

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('get_active_warehouse_gate_qr_v1', {
      p_warehouse_id: warehouse.id,
    });
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setError(null);
    const code = data as QrCode;
    setQr(code);
    try {
      const url = await QRCode.toDataURL(code.code_value, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#222223', light: '#ffffff' },
      });
      setImage(url);
    } catch {
      setError('Could not render warehouse QR code.');
    }
  }, [warehouse.id]);

  useEffect(() => {
    void load();
    // A one-second tick drives the countdown; the code itself is only re-polled
    // when it actually expires (below) plus a slow safety refresh every 5 min.
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const safety = window.setInterval(() => void load(), 300_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(safety);
    };
  }, [load]);

  const expiresAt = qr?.expires_at ? new Date(qr.expires_at).getTime() : null;
  const msLeft = expiresAt !== null ? expiresAt - now : null;
  const expired = msLeft !== null && msLeft <= 0;
  const expiringSoon = msLeft !== null && msLeft > 0 && msLeft <= 60_000;

  // Pull a fresh code the instant the current one expires, rather than waiting
  // for the slow safety refresh.
  useEffect(() => {
    if (expired && !reloadingRef.current) {
      reloadingRef.current = true;
      void load().finally(() => {
        reloadingRef.current = false;
      });
    }
  }, [expired, load]);

  const secondsLeft = msLeft !== null ? Math.max(0, Math.ceil(msLeft / 1000)) : null;
  const expiryLabel = (() => {
    if (msLeft === null) return null;
    if (expired) return 'Expired - refreshing…';
    if (expiringSoon) return `Refreshing in ${secondsLeft}s`;
    const mins = Math.floor((secondsLeft ?? 0) / 60);
    const secs = (secondsLeft ?? 0) % 60;
    return `Valid for ${mins}m ${secs.toString().padStart(2, '0')}s`;
  })();

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
          <img
            src={image}
            alt={`Scannable warehouse gate QR for ${warehouse.name}`}
            style={expired ? { opacity: 0.35, filter: 'grayscale(1)' } : undefined}
          />
          <code>{qr.code_value}</code>
          {expiryLabel && (
            <span className={`gate-qr-expiry${expired ? ' is-expired' : expiringSoon ? ' is-soon' : ''}`}>
              {expiryLabel}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
