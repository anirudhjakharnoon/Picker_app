import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOrders } from '../lib/useOrders';
import { useStoreNames } from '../lib/useStores';
import { submitAction } from '../lib/actions';
import { QrScannerView } from '../components/QrScannerView';
import { BagsGrid } from '../components/BagsGrid';
import { FullscreenSheet } from '../components/FullscreenSheet';
import { CheckIcon, PinIcon, ChevronsIcon } from '../components/icons';
import type { Order } from '../types/database';
import { OrderAcceptSwipe } from '../components/OrderAcceptSwipe';

type Screen =
  | { name: 'queue' }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'scan-bag-for-sort'; orderId: string }
  | { name: 'scan-hole'; orderId: string; holeNumber: string };

type QueueTab = 'pending' | 'in_progress' | 'picked_up';

// Where the picker physically hands bags over. There is no per-picker handover
// assignment in the data model yet, so this mirrors the reference UI's static
// label; when routing exists it can be swapped for the assigned warehouse.
const HANDOVER_SPOT = 'Parking No. 2 - Floor 3, Dubai Mall';

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
  const [activeTab, setActiveTab] = useState<QueueTab>('pending');
  const [toast, setToast] = useState<string | null>(null);

  // The handoff bar is `position: fixed`, so the scrollable content behind
  // it needs bottom padding reserved for exactly its rendered height — a
  // fixed guess is not safe, because the bar's height varies with content
  // (a long handover-spot address can wrap to two lines, tab labels can grow
  // counts, etc.). A stale/too-small guess previously let the bar physically
  // cover the last order card's "Pick Order" button, making it unclickable
  // even after scrolling all the way down.
  const screenRef = useRef<HTMLDivElement>(null);
  const [handoffBarHeight, setHandoffBarHeight] = useState(0);
  const handoffBarRef = useRef<HTMLDivElement>(null);

  // Intentionally re-runs every render (no deps array): it must reconnect
  // whenever the ref's DOM node changes identity (the bar mounting,
  // unmounting, or being replaced), which isn't expressible as a plain
  // dependency list. The ResizeObserver itself already dedupes redundant
  // `setHandoffBarHeight` calls to the same measured height for the common
  // case of re-rendering without any actual size change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = handoffBarRef.current;
    if (!el) {
      setHandoffBarHeight(0);
      return;
    }
    const update = () => setHandoffBarHeight(el.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  });

  const storeNameFor = (o: Order) => storeNames[o.store_id] ?? 'Store';

  const myOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.assigned_picker_id === profile?.id &&
          !['dispatched', 'completed', 'cancelled'].includes(o.status)
      ),
    [orders, profile?.id]
  );

  // "Pending pickup" — unassigned offers visible for swipe-accept.
  const pendingPickup = useMemo(
    () => orders.filter((o) => o.status === 'available'),
    [orders]
  );
  // "In progress" starts at acceptance, not just the first scanned bag. This
  // is the one active work item that locks the picker out of other offers
  // until every bag is collected.
  const inProgress = useMemo(
    () => myOrders.filter((o) => ['assigned', 'picking_in_progress'].includes(o.status)),
    [myOrders]
  );
  // "Picked up" — every bag scanned, not yet dropped off at the warehouse.
  const pickedUp = useMemo(() => myOrders.filter((o) => o.status === 'picked'), [myOrders]);
  // Already dropped off, currently being sorted into pigeon holes.
  const inSorting = useMemo(
    () => myOrders.filter((o) => SORTING_STATUSES.includes(o.status)),
    [myOrders]
  );

  // Handoff is only meaningful once every order the picker is carrying has
  // actually been fully picked — not just some of them.
  const myUnfinishedCount = useMemo(
    () => myOrders.filter((o) => ['assigned', 'picking_in_progress'].includes(o.status)).length,
    [myOrders]
  );
  const canHandoff = pickedUp.length > 0 && myUnfinishedCount === 0;
  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    if (inProgress.length > 0) setActiveTab('in_progress');
  }, [inProgress.length]);

  const acceptOrder = async (order: Order) => {
    const result = await submitAction('accept_order', () => ({ p_order_id: order.id }));
    if (!result.ok) {
      notify(`Could not accept this order: ${result.error}`);
      return;
    }
    await refetch();
    setActiveTab('in_progress');
    setScreen({ name: 'scan-pickup', orderId: order.id });
  };

  const tabOrders: Record<QueueTab, Order[]> = {
    pending: pendingPickup,
    in_progress: inProgress,
    picked_up: pickedUp,
  };

  // ---- Queue (Pending Pickup) --------------------------------------------
  if (screen.name === 'queue') {
    return (
      <div
        className="picker-screen"
        ref={screenRef}
        style={handoffBarHeight ? { paddingBottom: handoffBarHeight + 24 } : undefined}
      >
        <header className="picker-topbar">
          <h1 className="picker-title">Pending Pickup</h1>
        </header>

        {toast && <div className="toast">{toast}</div>}

        <>
            <div className="filter-chips" role="tablist" aria-label="Order filters">
              {inProgress.length === 0 && <FilterChip
                label={`Pending pickup${pendingPickup.length ? ` (${pendingPickup.length})` : ''}`}
                active={activeTab === 'pending'}
                onClick={() => setActiveTab('pending')}
              />}
              <FilterChip
                label={`In progress${inProgress.length ? ` (${inProgress.length})` : ''}`}
                active={activeTab === 'in_progress'}
                onClick={() => setActiveTab('in_progress')}
              />
              {inProgress.length === 0 && <FilterChip
                label={`Picked up${pickedUp.length ? ` (${pickedUp.length})` : ''}`}
                active={activeTab === 'picked_up'}
                onClick={() => setActiveTab('picked_up')}
              />}
            </div>

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
              {tabOrders[activeTab].length === 0 && (
                <div className="empty-state">{emptyStateFor(activeTab)}</div>
              )}
              {tabOrders[activeTab].map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  storeName={storeNameFor(o)}
                  pickerHasActiveOrder={inProgress.length > 0 || myOrders.some((order) => order.status === 'assigned')}
                  onAccept={() => void acceptOrder(o)}
                  onContinue={() => setScreen({ name: 'scan-pickup', orderId: o.id })}
                />
              ))}
            </div>

            <HandoffBar
              barRef={handoffBarRef}
              pickedCount={pickedUp.length}
              canHandoff={canHandoff}
              spot={HANDOVER_SPOT}
              onGoToHandoff={() => setScreen({ name: 'dropoff' })}
            />
        </>
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
            Take {pickedUp.length} picked-up order(s) to the handover spot:
          </p>
          <p className="handoff-address">
            <PinIcon /> {HANDOVER_SPOT}
          </p>
          <div className="order-list">
            {pickedUp.map((o) => (
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
            disabled={pickedUp.length === 0}
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
        orderIds={pickedUp.map((o) => o.id)}
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

function emptyStateFor(tab: QueueTab): string {
  if (tab === 'pending') return 'No orders waiting to be picked up right now.';
  if (tab === 'in_progress') return 'Nothing partially picked right now.';
  return 'No fully-picked orders yet.';
}

// ---------------------------------------------------------------------------
// Shared presentational pieces
// ---------------------------------------------------------------------------

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
  pickerHasActiveOrder,
  onAccept,
  onContinue,
}: {
  order: Order;
  storeName: string;
  pickerHasActiveOrder: boolean;
  onAccept: () => void;
  onContinue: () => void;
}) {
  const inProgress = order.status === 'picking_in_progress';
  const pickedUp = order.status === 'picked';
  return (
    <article className="order-card">
      <div className="order-card-head">
        <span className="order-number">{order.external_order_ref}</span>
        <span
          className={`state-pill ${pickedUp ? 'state-picked' : inProgress ? 'state-progress' : 'state-ready'}`}
        >
          {pickedUp ? 'Picked up' : inProgress ? 'In progress' : 'Ready'}
        </span>
        <span className="order-time">{formatTime(order.ingested_at)}</span>
      </div>

      <div className="order-card-body">
        <p className="order-line">
          Pickup from: <strong>{storeName}</strong>
        </p>
        {order.store_floor && (
          <p className="order-line">
            Floor: <strong>{order.store_floor}</strong>
          </p>
        )}
        {order.store_zone && <p className="order-line">Zone: {order.store_zone}</p>}
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

      {order.status === 'available' && (
        <OrderAcceptSwipe
          disabled={pickerHasActiveOrder}
          disabledMessage="Finish your current order before accepting another."
          onAccepted={onAccept}
        />
      )}
      {order.status === 'assigned' || inProgress ? (
        <button type="button" className="pick-button" onClick={onContinue}>
          {inProgress ? 'Continue picking' : 'Start picking'}
        </button>
      ) : null}
    </article>
  );
}

function HandoffBar({
  barRef,
  pickedCount,
  canHandoff,
  spot,
  onGoToHandoff,
}: {
  barRef: RefObject<HTMLDivElement | null>;
  pickedCount: number;
  canHandoff: boolean;
  spot: string;
  onGoToHandoff: () => void;
}) {
  return (
    <div className="handoff-bar" ref={barRef}>
      <p className="handoff-progress">
        <strong>{pickedCount}</strong> picked up order(s) ready for handoff
      </p>
      <div className="handoff-info">
        <span className="handoff-label">Handover spot</span>
        <span className="handoff-spot">
          <PinIcon /> {spot}
        </span>
      </div>
      <button
        type="button"
        className={`handoff-button ${canHandoff ? 'active' : ''}`}
        disabled={!canHandoff}
        onClick={onGoToHandoff}
        title={
          canHandoff
            ? undefined
            : 'Finish picking up every assigned order before you can go to handoff.'
        }
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
  const serverScanned = order?.bag_count_scanned_pickup ?? 0;
  const [optimisticScanned, setOptimisticScanned] = useState(serverScanned);
  const [phase, setPhase] = useState<PickupPhase>(
    expected > 0 && serverScanned >= expected ? 'all-collected' : 'scanning'
  );
  const [paused, setPaused] = useState(false);

  // The number actually shown is always the server's number once it catches
  // up — the optimistic value only fills the brief gap right after a tap so
  // the UI never looks like it "did nothing."
  const scanned = Math.max(optimisticScanned, serverScanned);
  const pending = Math.max(expected - scanned, 0);

  useEffect(() => {
    if (serverScanned >= optimisticScanned) setOptimisticScanned(serverScanned);
  }, [serverScanned, optimisticScanned]);

  if (!order) {
    return (
      <FullscreenSheet onClose={onClose}>
        <div className="empty-state">This order is no longer available.</div>
      </FullscreenSheet>
    );
  }

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

    const optimisticNext = Math.min(scanned + 1, expected);
    setOptimisticScanned(optimisticNext); // instant feedback, before the network call

    const result = await submitAction('scan_bag_pickup', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: order.id,
      p_qr_code_value: value,
      p_client_captured_at: new Date().toISOString(),
      p_device_id: navigator.userAgent.slice(0, 64),
    }));
    if (!result.ok) {
      setOptimisticScanned(serverScanned); // revert the optimistic bump
      notify(`Scan rejected: ${result.error}`);
      setPaused(false);
      return;
    }

    const data = result.data as { scanned: number } | undefined;
    const confirmed = data?.scanned ?? optimisticNext;
    setOptimisticScanned(confirmed);
    setPhase(confirmed >= expected ? 'all-collected' : 'collected-one');
    void refetch();
  };

  if (phase === 'scanning') {
    return (
      <FullscreenSheet onClose={onClose}>
        <div className="scan-heading fade-in">
          <p className="scan-order">Picking Order {order.external_order_ref}</p>
          <p className="scan-order">From: {storeName}</p>
          <h2 className="scan-title">Scan QR code</h2>
          <p className="scan-sub">Scan the QR code on the order bag</p>
          <p className="scan-progress">
            Collecting Bag {Math.min(scanned + 1, expected)}/{expected}
          </p>
          <p className="scan-counts">
            <strong>{scanned}</strong> picked up · <strong>{pending}</strong> pending
          </p>
        </div>
        <QrScannerView onDecode={handleDecode} paused={paused} />
      </FullscreenSheet>
    );
  }

  if (phase === 'collected-one') {
    return (
      <FullscreenSheet onClose={onClose}>
        <div className="sheet-body center fade-in">
          <h2>You have collected Bag #{scanned}</h2>
          <p className="sheet-sub">
            This order contains {expected} bags · <strong>{pending}</strong> pending, collect the
            next bag
          </p>
          <BagsGrid total={expected} collected={scanned} />
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
      </FullscreenSheet>
    );
  }

  // all-collected
  return (
    <FullscreenSheet onClose={onClose}>
      <div className="sheet-body center fade-in">
        <h2>You have collected all the bags!</h2>
        <p className="sheet-sub">
          <strong>{expected}</strong> of {expected} bags picked up
        </p>
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
    </FullscreenSheet>
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

  const completeArrival = (rows: WarehouseArrivalRow[]) => {
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

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

    const result = await submitAction('record_warehouse_arrival', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_gate_qr_value: value,
      p_order_ids: orderIds,
      p_client_captured_at: new Date().toISOString(),
    }));
    if (result.ok) {
      completeArrival((result.data as WarehouseArrivalRow[] | null) ?? []);
    } else {
      notify(`Could not record arrival: ${result.error}`);
      setPaused(false);
    }
  };

  return (
    <FullscreenSheet onClose={onClose}>
      <div className="scan-heading fade-in">
        <h2 className="scan-title">Scan warehouse gate</h2>
        <p className="scan-sub">Scan the QR code at the warehouse entrance to arrive</p>
      </div>
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
    </FullscreenSheet>
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
    const result = await submitAction('scan_bag_for_sort', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: orderId,
      p_qr_code_value: value,
      p_client_captured_at: new Date().toISOString(),
    }));
    if (result.ok) {
      const data = result.data as { pigeon_hole_number: string | null; overflow: boolean };
      if (data.overflow || !data.pigeon_hole_number) {
        notify('No pigeon hole reserved yet — hold this bag, we will notify you.');
        setPaused(false);
      } else {
        onHoleFound(data.pigeon_hole_number);
      }
    } else {
      notify(`Scan rejected: ${result.error}`);
      setPaused(false);
    }
  };

  return (
    <FullscreenSheet onClose={onClose}>
      <div className="scan-heading fade-in">
        <h2 className="scan-title">Scan bag</h2>
        <p className="scan-sub">Scan a bag to see which pigeon hole it goes to</p>
      </div>
      <QrScannerView onDecode={handleDecode} paused={paused} />
    </FullscreenSheet>
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
    const result = await submitAction('scan_pigeon_hole', (clientEventId) => ({
      p_client_event_id: clientEventId,
      p_order_id: orderId,
      p_pigeon_hole_qr_value: value,
      p_client_captured_at: new Date().toISOString(),
    }));
    if (result.ok) {
      setSuccess(true);
      window.setTimeout(onDone, 1200);
    } else {
      notify(`Scan rejected: ${result.error}`);
      setPaused(false);
    }
  };

  if (success) {
    return (
      <FullscreenSheet onClose={onDone}>
        <div className="sheet-body center fade-in">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>Bag placed in {holeNumber}</h2>
        </div>
      </FullscreenSheet>
    );
  }

  return (
    <FullscreenSheet onClose={onDone}>
      <div className="scan-heading fade-in">
        <h2 className="scan-title">Scan hole {holeNumber}</h2>
        <p className="scan-sub">Scan the QR code on pigeon hole {holeNumber}</p>
      </div>
      <QrScannerView onDecode={handleDecode} paused={paused} />
    </FullscreenSheet>
  );
}
