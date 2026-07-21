import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOrders } from '../lib/useOrders';
import { useStoreNames } from '../lib/useStores';
import { submitAction } from '../lib/actions';
import { onSync } from '../lib/syncEngine';
import { QrScannerView } from '../components/QrScannerView';
import { BagsGrid } from '../components/BagsGrid';
import {
  CheckIcon,
  HeadsetIcon,
  MenuIcon,
  PinIcon,
  ChevronsIcon,
} from '../components/icons';
import type { Order } from '../types/database';
import { usePendingCount } from '../lib/usePendingCount';

type Screen =
  | { name: 'queue' }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'scan-bag-for-sort'; orderId: string }
  | { name: 'scan-hole'; orderId: string; holeNumber: string };

type QueueFilter = 'all' | 'ready' | 'in_progress';

// Where the picker physically hands bags over. There is no per-picker handover
// assignment in the data model yet, so this mirrors the reference UI's static
// label; when routing exists it can be swapped for the assigned warehouse.
const HANDOVER_SPOT = 'Parking No. 2 - Floor 3, Dubai Mall';

const READY_TO_TRANSIT: Order['status'][] = ['picked'];
const SORTING_STATUSES: Order['status'][] = ['arrived_at_warehouse', 'sorting_in_progress'];

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function PickerPage() {
  const { profile } = useAuth();
  const { orders, refetch } = useOrders();
  const storeNames = useStoreNames();
  const [screen, setScreen] = useState<Screen>({ name: 'queue' });
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingCount = usePendingCount();

  const storeNameFor = (o: Order) => storeNames[o.store_id] ?? 'Store';

  const myActive = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.assigned_picker_id === profile?.id &&
          !['dispatched', 'completed', 'cancelled'].includes(o.status)
      ),
    [orders, profile?.id]
  );

  // Orders that still need to be picked up (queue on the Pending Pickup screen).
  const pickable = useMemo(
    () =>
      orders.filter(
        (o) =>
          (o.status === 'available' && !o.assigned_picker_id) ||
          (o.assigned_picker_id === profile?.id &&
            ['assigned', 'picking_in_progress'].includes(o.status))
      ),
    [orders, profile?.id]
  );

  const filteredQueue = useMemo(() => {
    if (filter === 'ready') return pickable.filter((o) => o.status === 'available');
    if (filter === 'in_progress')
      return pickable.filter((o) => ['assigned', 'picking_in_progress'].includes(o.status));
    return pickable;
  }, [pickable, filter]);

  const readyForDropoff = myActive.filter((o) => READY_TO_TRANSIT.includes(o.status));
  const inSorting = myActive.filter((o) => SORTING_STATUSES.includes(o.status));

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  const toggleOnline = async () => {
    setBusy(true);
    const wasOnline = profile?.is_online;
    const { immediate } = await submitAction('set_picker_status', () => ({
      p_is_online: !wasOnline,
    }));
    setBusy(false);
    if (immediate && !immediate.ok) notify(`Could not update status: ${immediate.error}`);
    else {
      notify(wasOnline ? 'You are now offline' : 'You are now online');
      void refetch();
    }
  };

  // "Pick Order" from the queue: accept first if the order is still an open
  // offer (keeps the accept -> scan DB invariant), then open the scanner.
  const startPicking = async (order: Order) => {
    if (order.status === 'available') {
      setBusy(true);
      const { immediate } = await submitAction('accept_order', () => ({ p_order_id: order.id }));
      setBusy(false);
      if (immediate && !immediate.ok) {
        notify(`Could not start this order: ${immediate.error}`);
        void refetch();
        return;
      }
      void refetch();
    }
    setScreen({ name: 'scan-pickup', orderId: order.id });
  };

  // ---- Queue (Pending Pickup) --------------------------------------------
  if (screen.name === 'queue') {
    return (
      <div className="picker-screen">
        <PickerHeader profile={profile} busy={busy} onToggleOnline={toggleOnline} />

        {toast && <div className="toast">{toast}</div>}

        <div className="filter-chips" role="tablist" aria-label="Order filters">
          <FilterChip label="All orders" active={filter === 'all'} onClick={() => setFilter('all')} />
          <FilterChip label="Ready" active={filter === 'ready'} onClick={() => setFilter('ready')} />
          <FilterChip
            label="In progress"
            active={filter === 'in_progress'}
            onClick={() => setFilter('in_progress')}
          />
        </div>

        {pendingCount > 0 && (
          <p className="sync-note">{pendingCount} action(s) waiting to sync</p>
        )}

        {inSorting.length > 0 && (
          <button
            type="button"
            className="cta-banner secondary"
            onClick={() => setScreen({ name: 'sorting' })}
          >
            Continue sorting {inSorting.length} order(s)
          </button>
        )}

        <div className="order-list">
          {!profile?.is_online && (
            <div className="empty-state">You&apos;re offline. Go online to receive orders.</div>
          )}
          {profile?.is_online && filteredQueue.length === 0 && (
            <div className="empty-state">No orders here right now — stay online.</div>
          )}
          {filteredQueue.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              storeName={storeNameFor(o)}
              busy={busy}
              onPick={() => void startPicking(o)}
            />
          ))}
        </div>

        <HandoffBar
          pickedCount={readyForDropoff.length}
          spot={HANDOVER_SPOT}
          onGoToHandoff={() => setScreen({ name: 'dropoff' })}
        />
      </div>
    );
  }

  // ---- Pickup (scan bags with grid confirmations) ------------------------
  if (screen.name === 'scan-pickup') {
    const order = orders.find((o) => o.id === screen.orderId);
    return (
      <PickupFlow
        order={order}
        storeName={order ? storeNameFor(order) : 'Store'}
        onClose={() => {
          void refetch();
          setScreen({ name: 'queue' });
        }}
        notify={notify}
        refetch={refetch}
      />
    );
  }

  // ---- Handoff confirmation ----------------------------------------------
  if (screen.name === 'dropoff') {
    return (
      <div className="picker-screen">
        <SheetHeader title="Go to handoff" onClose={() => setScreen({ name: 'queue' })} />
        <div className="sheet-body">
          <p className="sheet-lead">
            Take {readyForDropoff.length} picked-up order(s) to the handover spot:
          </p>
          <p className="handoff-address">
            <PinIcon /> {HANDOVER_SPOT}
          </p>
          <div className="order-list">
            {readyForDropoff.map((o) => (
              <div key={o.id} className="order-mini">
                <strong>{o.external_order_ref}</strong>
                <span>{o.bag_count_expected} bags</span>
              </div>
            ))}
          </div>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="cta-banner"
            disabled={readyForDropoff.length === 0}
            onClick={() => setScreen({ name: 'scan-gate' })}
          >
            Scan warehouse gate to arrive
          </button>
        </div>
      </div>
    );
  }

  if (screen.name === 'scan-gate') {
    return (
      <GateScanScreen
        orderIds={readyForDropoff.map((o) => o.id)}
        onClose={() => setScreen({ name: 'queue' })}
        onDone={async () => {
          await refetch();
          setScreen({ name: 'sorting' });
        }}
        notify={notify}
      />
    );
  }

  // ---- Sorting into pigeon holes -----------------------------------------
  if (screen.name === 'sorting') {
    return (
      <div className="picker-screen">
        <SheetHeader title="Sort into pigeon holes" onClose={() => setScreen({ name: 'queue' })} />
        <div className="order-list">
          {inSorting.length === 0 && (
            <div className="empty-state">Nothing left to sort. Great work!</div>
          )}
          {inSorting.map((o) => (
            <button
              key={o.id}
              type="button"
              className="order-card tappable"
              onClick={() => setScreen({ name: 'scan-bag-for-sort', orderId: o.id })}
            >
              <div className="order-card-head">
                <span className="order-number">{o.external_order_ref}</span>
              </div>
              <div className="order-line muted">
                Sorted {o.bag_count_scanned_sort}/{o.bag_count_expected} bags
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (screen.name === 'scan-bag-for-sort') {
    return (
      <ScanBagForSortScreen
        orderId={screen.orderId}
        onHoleFound={(holeNumber) =>
          setScreen({ name: 'scan-hole', orderId: screen.orderId, holeNumber })
        }
        onClose={() => setScreen({ name: 'sorting' })}
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
          void refetch();
          setScreen({ name: 'sorting' });
        }}
        notify={notify}
      />
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared presentational pieces
// ---------------------------------------------------------------------------

function PickerHeader({
  profile,
  busy,
  onToggleOnline,
}: {
  profile: ReturnType<typeof useAuth>['profile'];
  busy: boolean;
  onToggleOnline: () => void;
}) {
  const online = profile?.is_online ?? false;
  return (
    <header className="picker-topbar">
      <button type="button" className="icon-button" aria-label="Menu">
        <MenuIcon />
      </button>
      <h1 className="picker-title">Pending Pickup</h1>
      <button
        type="button"
        className={`online-toggle ${online ? 'is-online' : ''}`}
        onClick={onToggleOnline}
        disabled={busy}
        aria-pressed={online}
      >
        {online ? 'Online' : 'Offline'}
        <span className="online-dot">{online ? <CheckIcon /> : null}</span>
      </button>
      <span className="icon-button" aria-hidden="true">
        <HeadsetIcon />
      </span>
    </header>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`filter-chip ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OrderCard({
  order,
  storeName,
  busy,
  onPick,
}: {
  order: Order;
  storeName: string;
  busy: boolean;
  onPick: () => void;
}) {
  const inProgress = ['assigned', 'picking_in_progress'].includes(order.status);
  return (
    <article className="order-card">
      <div className="order-card-head">
        <span className="order-number">{order.external_order_ref}</span>
        <span className={`state-pill ${inProgress ? 'state-progress' : 'state-ready'}`}>
          {inProgress ? 'In progress' : 'Ready'}
        </span>
        <span className="order-time">{formatTime(order.ingested_at)}</span>
      </div>

      <div className="order-card-body">
        <p className="order-store">Pickup from DC: {storeName}</p>
        {(order.store_floor || order.store_zone) && (
          <p className="order-line">
            {order.store_floor ? (
              <>
                Floor: <strong>{order.store_floor}</strong>
              </>
            ) : null}
            {order.store_floor && order.store_zone ? ' · ' : ''}
            {order.store_zone ? (
              <>
                Zone: <strong>{order.store_zone}</strong>
              </>
            ) : null}
          </p>
        )}
        {order.store_address && <p className="order-line muted">{order.store_address}</p>}
      </div>

      <div className="order-card-foot">
        <span className="bag-count">{order.bag_count_expected} Bags</span>
        {order.is_fragile && (
          <span className="fragile-pill">
            <FragileGlyph /> Fragile Items
          </span>
        )}
      </div>

      <button type="button" className="pick-button" onClick={onPick} disabled={busy}>
        {inProgress ? 'Continue picking' : 'Pick Order'}
      </button>
    </article>
  );
}

function HandoffBar({
  pickedCount,
  spot,
  onGoToHandoff,
}: {
  pickedCount: number;
  spot: string;
  onGoToHandoff: () => void;
}) {
  const active = pickedCount > 0;
  return (
    <div className="handoff-bar">
      <div className="picked-pill">
        Picked up orders <span className="picked-count">{pickedCount}</span>
      </div>
      <div className="handoff-info">
        <span className="handoff-label">Handover spot</span>
        <span className="handoff-spot">
          <PinIcon /> {spot}
        </span>
      </div>
      <button
        type="button"
        className={`handoff-button ${active ? 'active' : ''}`}
        disabled={!active}
        onClick={onGoToHandoff}
      >
        <span className="handoff-chevrons">
          <ChevronsIcon />
        </span>
        Go to handoff
      </button>
    </div>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="sheet-header">
      <span className="sheet-grip" aria-hidden="true" />
      <div className="sheet-header-row">
        <h2>{title}</h2>
        <button type="button" className="icon-button close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}

function FragileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 2h8l-1 7a4 4 0 0 1-2 3.46V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-7.54A4 4 0 0 1 9 9L8 2Z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pickup flow (scan -> per-bag confirmation grid -> all collected)
// ---------------------------------------------------------------------------

type PickupPhase = 'scanning' | 'collected-one' | 'all-collected';

function PickupFlow({
  order,
  storeName,
  onClose,
  notify,
  refetch,
}: {
  order: Order | undefined;
  storeName: string;
  onClose: () => void;
  notify: (msg: string) => void;
  refetch: () => Promise<void>;
}) {
  const expected = order?.bag_count_expected ?? 0;
  const [collected, setCollected] = useState(order?.bag_count_scanned_pickup ?? 0);
  const [phase, setPhase] = useState<PickupPhase>(
    (order?.bag_count_scanned_pickup ?? 0) >= (order?.bag_count_expected ?? 1)
      ? 'all-collected'
      : 'scanning'
  );
  const [paused, setPaused] = useState(false);

  if (!order) {
    return (
      <div className="picker-screen">
        <SheetHeader title="Order unavailable" onClose={onClose} />
        <div className="empty-state">This order is no longer available.</div>
      </div>
    );
  }

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

    const { immediate } = await submitAction('scan_bag_pickup', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: order.id,
      p_qr_code_value: value,
      p_client_captured_at: new Date().toISOString(),
      p_device_id: navigator.userAgent.slice(0, 64),
    }));

    let newCount = collected;
    if (immediate?.ok) {
      const data = immediate.data as { scanned: number } | undefined;
      newCount = data?.scanned ?? collected + 1;
      void refetch();
    } else if (immediate) {
      notify(`Scan rejected: ${immediate.error}`);
      setPaused(false);
      return;
    } else {
      // Offline: optimistically advance; the sync engine reconciles later.
      newCount = Math.min(collected + 1, expected);
      notify('Offline — bag saved, will sync automatically.');
    }

    setCollected(newCount);
    setPhase(newCount >= expected ? 'all-collected' : 'collected-one');
  };

  if (phase === 'scanning') {
    return (
      <div className="picker-screen scan-sheet">
        <SheetHeader title="" onClose={onClose} />
        <div className="scan-heading">
          <p className="scan-order">Picking Order {order.external_order_ref}</p>
          <p className="scan-order">From: {storeName}</p>
          <h2 className="scan-title">Scan QR code</h2>
          <p className="scan-sub">Scan the QR code on the order bag</p>
          <p className="scan-progress">
            Collecting Bag {Math.min(collected + 1, expected)}/{expected}
          </p>
        </div>
        <QrScannerView onDecode={handleDecode} paused={paused} />
      </div>
    );
  }

  if (phase === 'collected-one') {
    return (
      <div className="picker-screen sheet-centered">
        <SheetHeader title="" onClose={onClose} />
        <div className="sheet-body center">
          <h2>You have collected Bag #{collected}</h2>
          <p className="sheet-sub">
            This order contains {expected} bags, collect the next bag
          </p>
          <BagsGrid total={expected} collected={collected} />
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="dark-button"
            onClick={() => {
              setPaused(false);
              setPhase('scanning');
            }}
          >
            Pick up next bag
          </button>
        </div>
      </div>
    );
  }

  // all-collected
  return (
    <div className="picker-screen sheet-centered">
      <SheetHeader title="" onClose={onClose} />
      <div className="sheet-body center">
        <h2>You have collected all the bags!</h2>
        <BagsGrid total={expected} collected={expected} />
      </div>
      <div className="sheet-footer">
        <button
          type="button"
          className="dark-button"
          onClick={() => {
            void refetch();
            onClose();
          }}
        >
          Done!
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warehouse gate + sorting screens (styling refreshed, logic unchanged)
// ---------------------------------------------------------------------------

interface WarehouseArrivalRow {
  order_id: string;
  pigeon_hole_number: string | null;
  reserved: boolean;
}

function GateScanScreen({
  orderIds,
  onClose,
  onDone,
  notify,
}: {
  orderIds: string[];
  onClose: () => void;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocalId]);

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

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
      notify('Arrival saved. Stay on this screen; sorting opens after hole assignment.');
    }
  };

  return (
    <div className="picker-screen scan-sheet">
      <SheetHeader title="" onClose={onClose} />
      <div className="scan-heading">
        <h2 className="scan-title">Scan warehouse gate</h2>
        <p className="scan-sub">Scan the QR code at the warehouse entrance to arrive</p>
      </div>
      {pendingLocalId && (
        <div className="flow-status" role="status">
          <span className="flow-status-spinner" aria-hidden="true" />
          Waiting for connection and pigeon-hole assignment…
        </div>
      )}
      {!result && <QrScannerView onDecode={handleDecode} paused={paused} />}
      {result && (
        <ul className="arrival-list">
          {result.map((r) => (
            <li key={r.order_id}>
              {r.reserved ? `Go to hole ${r.pigeon_hole_number}` : 'No hole yet — hold in staging'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScanBagForSortScreen({
  orderId,
  onHoleFound,
  onClose,
  notify,
}: {
  orderId: string;
  onHoleFound: (holeNumber: string) => void;
  onClose: () => void;
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
        notify('No pigeon hole reserved yet — hold this bag, we will notify you.');
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
    <div className="picker-screen scan-sheet">
      <SheetHeader title="" onClose={onClose} />
      <div className="scan-heading">
        <h2 className="scan-title">Scan bag</h2>
        <p className="scan-sub">Scan a bag to see which pigeon hole it goes to</p>
      </div>
      <QrScannerView onDecode={handleDecode} paused={paused} />
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
      <div className="picker-screen sheet-centered">
        <div className="sheet-body center">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>Bag placed in {holeNumber}</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="picker-screen scan-sheet">
      <div className="scan-heading">
        <h2 className="scan-title">Scan hole {holeNumber}</h2>
        <p className="scan-sub">Scan the QR code on pigeon hole {holeNumber}</p>
      </div>
      <QrScannerView onDecode={handleDecode} paused={paused} />
    </div>
  );
}
