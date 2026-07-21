import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOrders } from '../lib/useOrders';
import { submitAction } from '../lib/actions';
import { onSync } from '../lib/syncEngine';
import { QrScannerView } from '../components/QrScannerView';
import type { Order } from '../types/database';
import { usePendingCount } from '../lib/usePendingCount';

type Screen =
  | { name: 'queue' }
  | { name: 'order-detail'; orderId: string }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'scan-bag-for-sort'; orderId: string }
  | { name: 'scan-hole'; orderId: string; holeNumber: string };

const READY_TO_TRANSIT: Order['status'][] = ['picked'];
const SORTING_STATUSES: Order['status'][] = ['arrived_at_warehouse', 'sorting_in_progress'];

export function PickerPage() {
  const { profile } = useAuth();
  const { orders, refetch } = useOrders();
  const [screen, setScreen] = useState<Screen>({ name: 'queue' });
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingCount = usePendingCount();

  const available = useMemo(() => orders.filter((o) => o.status === 'available'), [orders]);
  const myActive = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.assigned_picker_id === profile?.id &&
          !['dispatched', 'completed', 'cancelled'].includes(o.status)
      ),
    [orders, profile?.id]
  );
  const readyForDropoff = myActive.filter((o) => READY_TO_TRANSIT.includes(o.status));
  const inSorting = myActive.filter((o) => SORTING_STATUSES.includes(o.status));

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  const toggleOnline = async () => {
    setBusy(true);
    const { immediate } = await submitAction('set_picker_status', () => ({
      p_is_online: !profile?.is_online,
    }));
    setBusy(false);
    if (immediate && !immediate.ok) notify(`Could not update status: ${immediate.error}`);
    else notify(profile?.is_online ? 'You are now offline' : 'You are now online');
  };

  const acceptOrder = async (orderId: string) => {
    setBusy(true);
    const { immediate } = await submitAction('accept_order', () => ({ p_order_id: orderId }));
    setBusy(false);
    if (immediate && !immediate.ok) {
      notify(`Could not accept order: ${immediate.error}`);
    } else {
      notify('Order accepted.');
      void refetch();
    }
  };

  if (screen.name === 'queue') {
    return (
      <div className="picker-screen">
        <header className="picker-header">
          <div>
            <strong>{profile?.full_name ?? profile?.email}</strong>
            <div className="pending-badge">
              {pendingCount > 0 ? `${pendingCount} action(s) waiting to sync` : 'All synced'}
            </div>
          </div>
          <button type="button" onClick={toggleOnline} disabled={busy}>
            {profile?.is_online ? 'Go offline' : 'Go online'}
          </button>
        </header>

        {toast && <div className="toast">{toast}</div>}

        {!profile?.is_online && (
          <p className="empty-state">You&apos;re offline. Go online to receive orders.</p>
        )}

        {readyForDropoff.length > 0 && (
          <button type="button" className="cta-banner" onClick={() => setScreen({ name: 'dropoff' })}>
            {readyForDropoff.length} order(s) ready — go to dropoff →
          </button>
        )}

        {inSorting.length > 0 && (
          <button type="button" className="cta-banner secondary" onClick={() => setScreen({ name: 'sorting' })}>
            Continue sorting {inSorting.length} order(s) →
          </button>
        )}

        <section>
          <h2>Available orders</h2>
          {available.length === 0 && <p className="empty-state">No orders right now — stay online.</p>}
          {available.map((o) => (
            <div key={o.id} className="order-card">
              <div>
                <strong>{o.external_order_ref}</strong>
                <div>{o.store_address ?? 'No address on file'}</div>
                <div>
                  Floor {o.store_floor ?? '–'} · Zone {o.store_zone ?? '–'} · {o.bag_count_expected} bag(s)
                </div>
              </div>
              <button type="button" onClick={() => acceptOrder(o.id)} disabled={busy}>
                Accept
              </button>
            </div>
          ))}
        </section>

        <section>
          <h2>My active orders</h2>
          {myActive.length === 0 && <p className="empty-state">Nothing in progress.</p>}
          {myActive.map((o) => (
            <div key={o.id} className="order-card clickable" onClick={() => setScreen({ name: 'order-detail', orderId: o.id })}>
              <div>
                <strong>{o.external_order_ref}</strong>
                <div className="status-pill">{o.status.replace(/_/g, ' ')}</div>
                <div>
                  Pickup {o.bag_count_scanned_pickup}/{o.bag_count_expected} · Sort {o.bag_count_scanned_sort}/{o.bag_count_expected}
                </div>
              </div>
            </div>
          ))}
        </section>
      </div>
    );
  }

  if (screen.name === 'order-detail') {
    const order = orders.find((o) => o.id === screen.orderId);
    if (!order) return <BackToQueue setScreen={setScreen} message="Order no longer available." />;
    return (
      <div className="picker-screen">
        <BackButton onClick={() => setScreen({ name: 'queue' })} />
        <h2>{order.external_order_ref}</h2>
        <p>{order.store_address}</p>
        <p>
          Floor {order.store_floor ?? '–'} · Zone {order.store_zone ?? '–'}
        </p>
        <p>
          {order.bag_count_scanned_pickup} of {order.bag_count_expected} bags scanned
        </p>
        <button
          type="button"
          disabled={!['assigned', 'picking_in_progress'].includes(order.status)}
          onClick={() => setScreen({ name: 'scan-pickup', orderId: order.id })}
        >
          Pick order
        </button>
      </div>
    );
  }

  if (screen.name === 'scan-pickup') {
    return (
      <PickupScanScreen
        orderId={screen.orderId}
        orders={orders}
        onDone={() => setScreen({ name: 'queue' })}
        notify={notify}
        refetch={refetch}
      />
    );
  }

  if (screen.name === 'dropoff') {
    return (
      <div className="picker-screen">
        <BackButton onClick={() => setScreen({ name: 'queue' })} />
        <h2>Go to dropoff</h2>
        <p>You have {readyForDropoff.length} order(s) ready to take to the warehouse:</p>
        <ul>
          {readyForDropoff.map((o) => (
            <li key={o.id}>{o.external_order_ref}</li>
          ))}
        </ul>
        <button type="button" className="cta-banner" onClick={() => setScreen({ name: 'scan-gate' })}>
          Slide to confirm arrival →
        </button>
      </div>
    );
  }

  if (screen.name === 'scan-gate') {
    return (
      <GateScanScreen
        orderIds={readyForDropoff.map((o) => o.id)}
        onDone={async () => {
          // Warehouse arrival changes each order from `picked` to
          // `sorting_in_progress`. Wait for the authoritative refetch before
          // rendering the Sorting screen; otherwise its derived `inSorting`
          // list is momentarily empty and the picker appears stuck.
          await refetch();
          setScreen({ name: 'sorting' });
        }}
        notify={notify}
      />
    );
  }

  if (screen.name === 'sorting') {
    return (
      <div className="picker-screen">
        <BackButton onClick={() => setScreen({ name: 'queue' })} />
        <h2>Sort into pigeon holes</h2>
        {inSorting.length === 0 && <p className="empty-state">Nothing left to sort. Great work.</p>}
        {inSorting.map((o) => (
          <div key={o.id} className="order-card clickable" onClick={() => setScreen({ name: 'scan-bag-for-sort', orderId: o.id })}>
            <strong>{o.external_order_ref}</strong>
            <div>
              Sorted {o.bag_count_scanned_sort}/{o.bag_count_expected}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (screen.name === 'scan-bag-for-sort') {
    return (
      <ScanBagForSortScreen
        orderId={screen.orderId}
        onHoleFound={(holeNumber) => setScreen({ name: 'scan-hole', orderId: screen.orderId, holeNumber })}
        onBack={() => setScreen({ name: 'sorting' })}
        notify={notify}
      />
    );
  }

  if (screen.name === 'scan-hole') {
    return (
      <ScanHoleScreen
        orderId={screen.orderId}
        holeNumber={screen.holeNumber}
        onDone={() => {
          setScreen({ name: 'sorting' });
          void refetch();
        }}
        notify={notify}
      />
    );
  }

  return null;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back-button" onClick={onClick}>
      ← Back
    </button>
  );
}

function BackToQueue({ setScreen, message }: { setScreen: (s: Screen) => void; message: string }) {
  return (
    <div className="picker-screen">
      <p className="empty-state">{message}</p>
      <button type="button" onClick={() => setScreen({ name: 'queue' })}>
        Back to queue
      </button>
    </div>
  );
}

function PickupScanScreen({
  orderId,
  orders,
  onDone,
  notify,
  refetch,
}: {
  orderId: string;
  orders: Order[];
  onDone: () => void;
  notify: (msg: string) => void;
  refetch: () => Promise<void>;
}) {
  const [paused, setPaused] = useState(false);
  const order = orders.find((o) => o.id === orderId);
  const scanned = order?.bag_count_scanned_pickup ?? 0;
  const expected = order?.bag_count_expected ?? 0;

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);
    const { immediate } = await submitAction('scan_bag_pickup', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: orderId,
      p_qr_code_value: value,
      p_client_captured_at: new Date().toISOString(),
      p_device_id: navigator.userAgent.slice(0, 64),
    }));

    if (immediate) {
      if (immediate.ok) {
        const data = immediate.data as { scanned: number; expected: number; order_status: string } | undefined;
        notify(data ? `Bag scanned: ${data.scanned} of ${data.expected}` : 'Bag scanned');
        void refetch();
      } else {
        notify(`Scan rejected: ${immediate.error}`);
      }
    } else {
      notify('Offline — scan saved, will sync automatically.');
    }
    window.setTimeout(() => setPaused(false), 600);
  };

  return (
    <div className="picker-screen">
      <BackButton onClick={onDone} />
      <h2>Scan bags</h2>
      <p className="scan-counter">
        {scanned} of {expected} collected
      </p>
      <QrScannerView
        onDecode={handleDecode}
        paused={paused}
        helperText="Scan the QR code on each bag for this order."
      />
      <button type="button" disabled={scanned < expected} onClick={onDone}>
        {scanned < expected ? `${expected - scanned} bag(s) remaining` : 'Done'}
      </button>
    </div>
  );
}

function GateScanScreen({
  orderIds,
  onDone,
  notify,
}: {
  orderIds: string[];
  onDone: () => Promise<void>;
  notify: (msg: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<WarehouseArrivalRow[] | null>(null);
  const [pendingLocalId, setPendingLocalId] = useState<string | null>(null);

  const completeArrival = (rows: WarehouseArrivalRow[]) => {
    setPendingLocalId(null);
    setResult(rows);
    const overflow = rows.filter((row) => !row.reserved);
    if (overflow.length > 0) {
      notify(`${overflow.length} order(s) have no free hole yet — hold those bags for staging.`);
    } else {
      notify('Pigeon holes assigned. Continue to sorting.');
    }
    window.setTimeout(() => {
      void onDone();
    }, 900);
  };

  useEffect(() => {
    if (!pendingLocalId) return;
    const unsubscribe = onSync((results) => {
      const match = results.find((entry) => entry.action.clientEventId === pendingLocalId);
      if (!match) return;
      if (match.ok) {
        completeArrival((match.data as WarehouseArrivalRow[] | null) ?? []);
      } else if (!match.retryable) {
        setPendingLocalId(null);
        setPaused(false);
        notify(`Could not record arrival: ${match.error}`);
      }
    });
    return () => {
      unsubscribe();
    };
    // `completeArrival` intentionally reads current props/state; the only
    // subscription identity is the stable local event id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocalId]);

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);
    if (!navigator.onLine) {
      const { localId } = await submitAction('record_warehouse_arrival', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_gate_qr_value: value,
        p_order_ids: orderIds,
        p_client_captured_at: new Date().toISOString(),
      }));
      setPendingLocalId(localId);
      notify('Offline — arrival is saved. Stay on this screen; sorting will open after reconnection and hole assignment.');
      return;
    }

    const { immediate, localId } = await submitAction('record_warehouse_arrival', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_gate_qr_value: value,
      p_order_ids: orderIds,
      p_client_captured_at: new Date().toISOString(),
    }));

    if (immediate?.ok) {
      completeArrival((immediate.data as WarehouseArrivalRow[] | null) ?? []);
    } else if (immediate) {
      notify(`Could not record arrival: ${immediate.error}`);
      setPaused(false);
    } else {
      setPendingLocalId(localId);
      notify('Arrival is still syncing. Stay on this screen; sorting will open automatically.');
    }
  };

  return (
    <div className="picker-screen">
      <h2>Scan warehouse gate</h2>
      {pendingLocalId && (
        <div className="flow-status" role="status">
          <span className="flow-status-spinner" aria-hidden="true" />
          Waiting for connection and pigeon-hole assignment…
        </div>
      )}
      {!result && (
        <QrScannerView onDecode={handleDecode} paused={paused} helperText="Scan the QR code at the warehouse entrance." />
      )}
      {result && (
        <ul>
          {result.map((r) => (
            <li key={r.order_id}>
              {r.order_id.slice(0, 8)}: {r.reserved ? `Hole ${r.pigeon_hole_number}` : 'No hole yet — hold in staging'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface WarehouseArrivalRow {
  order_id: string;
  pigeon_hole_number: string | null;
  reserved: boolean;
}

function ScanBagForSortScreen({
  orderId,
  onHoleFound,
  onBack,
  notify,
}: {
  orderId: string;
  onHoleFound: (holeNumber: string) => void;
  onBack: () => void;
  notify: (msg: string) => void;
}) {
  const [paused, setPaused] = useState(false);

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);
    const { immediate } = await submitAction('scan_bag_for_sort', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: orderId,
      p_qr_code_value: value,
      p_client_captured_at: new Date().toISOString(),
    }));

    if (immediate?.ok) {
      const data = immediate.data as { pigeon_hole_number: string | null; overflow: boolean };
      if (data.overflow || !data.pigeon_hole_number) {
        notify('No pigeon hole reserved yet for this order — hold this bag, we will notify you.');
        setPaused(false);
      } else {
        onHoleFound(data.pigeon_hole_number);
      }
    } else if (immediate) {
      notify(`Scan rejected: ${immediate.error}`);
      setPaused(false);
    } else {
      notify('Offline — you need connectivity to look up the pigeon hole for this bag.');
      setPaused(false);
    }
  };

  return (
    <div className="picker-screen">
      <BackButton onClick={onBack} />
      <h2>Scan bag</h2>
      <QrScannerView onDecode={handleDecode} paused={paused} helperText="Scan the bag to see which pigeon hole it goes to." />
    </div>
  );
}

function ScanHoleScreen({
  orderId,
  holeNumber,
  onDone,
  notify,
}: {
  orderId: string;
  holeNumber: string;
  onDone: () => void;
  notify: (msg: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);
    const { immediate } = await submitAction('scan_pigeon_hole', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: orderId,
      p_pigeon_hole_qr_value: value,
      p_client_captured_at: new Date().toISOString(),
    }));

    if (immediate?.ok) {
      setSuccess(true);
      window.setTimeout(onDone, 1200);
    } else if (immediate) {
      notify(`Scan rejected: ${immediate.error}`);
      setPaused(false);
    } else {
      notify('Offline — hole scan saved, will sync automatically.');
      window.setTimeout(onDone, 800);
    }
  };

  if (success) {
    return (
      <div className="picker-screen scan-success">
        <div className="success-checkmark">✓</div>
        <p>Bag placed in {holeNumber}</p>
      </div>
    );
  }

  return (
    <div className="picker-screen">
      <h2>Scan hole {holeNumber}</h2>
      <QrScannerView onDecode={handleDecode} paused={paused} helperText={`Scan the QR code on pigeon hole ${holeNumber}.`} />
    </div>
  );
}
