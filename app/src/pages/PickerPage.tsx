import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOrders } from '../lib/useOrders';
import { useStoreNames } from '../lib/useStores';
import { submitAction } from '../lib/actions';
import { supabase } from '../lib/supabaseClient';
import { QrScannerView } from '../components/QrScannerView';
import { BagsGrid } from '../components/BagsGrid';
import { FullscreenSheet } from '../components/FullscreenSheet';
import { CheckIcon, PinIcon } from '../components/icons';
import type { Order } from '../types/database';
import { OrderAcceptSwipe } from '../components/OrderAcceptSwipe';

type Screen =
  | { name: 'queue' }
  | { name: 'order-detail'; orderId: string }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'drop-into-hole'; orderId: string; holeId: string; holeNumber: string };

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

  // Picker login means available for automatic zone assignment. This is a
  // presence heartbeat, not an offline-mode toggle (the app is online-only).
  useEffect(() => {
    if (profile?.role === 'picker' && !profile.is_online) {
      void supabase.rpc('set_picker_status_v1', { p_is_online: true });
    }
  }, [profile?.id, profile?.is_online, profile?.role]);

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

  // Automatically assigned orders stay in Pending until the picker confirms
  // the journey with the Go to store swipe.
  const pendingPickup = useMemo(
    () => myOrders.filter((o) => o.status === 'assigned'),
    [myOrders]
  );
  // "In progress" starts at acceptance, not just the first scanned bag. This
  // is the one active work item that locks the picker out of other offers
  // until every bag is collected.
  const inProgress = useMemo(
    () => myOrders.filter((o) => o.status === 'picking_in_progress'),
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
    setScreen({ name: 'order-detail', orderId: order.id });
  };

  const goToStore = async (order: Order) => {
    const { error } = await supabase.rpc('picker_go_to_store_v1', { p_order_id: order.id });
    if (error) {
      notify(`Cannot start this store: ${error.message}`);
      return;
    }
    await refetch();
    setActiveTab('in_progress');
    setScreen({ name: 'order-detail', orderId: order.id });
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
              <FilterChip
                label={`Pending${pendingPickup.length ? ` (${pendingPickup.length})` : ''}`}
                active={activeTab === 'pending'}
                onClick={() => setActiveTab('pending')}
              />
              <FilterChip
                label={`In progress${inProgress.length ? ` (${inProgress.length})` : ''}`}
                active={activeTab === 'in_progress'}
                onClick={() => setActiveTab('in_progress')}
              />
              <FilterChip
                label={`Picked up${pickedUp.length ? ` (${pickedUp.length})` : ''}`}
                active={activeTab === 'picked_up'}
                onClick={() => setActiveTab('picked_up')}
              />
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
                  pickerHasActiveOrder={inProgress.length > 0}
                  onAccept={() => void acceptOrder(o)}
                  onGoToStore={() => void goToStore(o)}
                  onContinue={() => setScreen({ name: 'order-detail', orderId: o.id })}
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

  if (screen.name === 'order-detail') {
    const order = orders.find((candidate) => candidate.id === screen.orderId);
    if (!order) {
      return <div className="picker-screen"><div className="empty-state">This order is no longer assigned to you.</div></div>;
    }
    return (
      <div className="picker-screen">
        <SheetHeader title="Order details" onClose={() => setScreen({ name: 'queue' })} />
        <article className="order-card">
          <div className="order-card-head">
            <span className="order-number">{order.external_order_ref}</span>
            <span className="state-pill state-progress">In progress</span>
          </div>
          <div className="order-card-body">
            <p className="order-line">Pickup from: <strong>{storeNameFor(order)}</strong></p>
            {order.store_floor && <p className="order-line">Floor: <strong>{order.store_floor}</strong></p>}
            {order.store_zone && <p className="order-line">Zone: {order.store_zone}</p>}
            {order.store_address && <p className="order-line muted">{order.store_address}</p>}
          </div>
          <div className="order-card-foot"><span className="bag-count">{order.bag_count_expected} Bags</span></div>
        </article>
        <div className="sheet-footer">
          <button type="button" className="dark-button" onClick={() => setScreen({ name: 'scan-pickup', orderId: order.id })}>
            {order.bag_count_scanned_pickup > 0 ? 'Continue picking' : 'Start picking'}
          </button>
        </div>
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
        toast={toast}
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
        toast={toast}
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
            <SortingOrderStep
              key={o.id}
              order={o}
              onOpenHole={(holeId, holeNumber) =>
                setScreen({ name: 'drop-into-hole', orderId: o.id, holeId, holeNumber })
              }
            />
          ))}
        </div>
      </div>
    );
  }

  if (screen.name === 'drop-into-hole') {
    return (
      <DropIntoHoleFlow
        orderId={screen.orderId}
        holeId={screen.holeId}
        holeNumber={screen.holeNumber}
        onDone={async () => {
          await refetch();
          setScreen({ name: 'sorting' });
        }}
        notify={notify}
        toast={toast}
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
  onGoToStore,
  onContinue,
}: {
  order: Order;
  storeName: string;
  pickerHasActiveOrder: boolean;
  onAccept: () => void;
  onGoToStore: () => void;
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
      {order.status === 'assigned' && (
        <OrderAcceptSwipe
          disabled={pickerHasActiveOrder}
          disabledMessage="Finish your in-progress store before going to another store."
          label="Swipe right to Go to store"
          busyLabel="Starting store…"
          onAccepted={onGoToStore}
        />
      )}
      {inProgress ? (
        <button type="button" className="pick-button" onClick={onContinue}>
          Continue picking
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
      <OrderAcceptSwipe
        disabled={!canHandoff}
        disabledMessage="Finish in-progress orders before handoff"
        label="Swipe right to Go to handoff"
        busyLabel="Opening handoff…"
        onAccepted={onGoToHandoff}
      />
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
  toast,
  refetch,
}: {
  order: Order | undefined;
  storeName: string;
  onClose: () => void;
  notify: (msg: string) => void;
  toast: string | null;
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
      <FullscreenSheet onClose={onClose} toast={toast}>
        <div className="empty-state">This order is no longer available.</div>
      </FullscreenSheet>
    );
  }

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

    const optimisticNext = Math.min(scanned + 1, expected);
    setOptimisticScanned(optimisticNext); // instant feedback, before the network call

    try {
      const result = await submitAction('scan_bag_pickup', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_order_id: order.id,
        p_qr_code_value: value,
        p_client_captured_at: new Date().toISOString(),
        p_device_id: navigator.userAgent.slice(0, 64),
      }));
      if (!result.ok) {
        setOptimisticScanned(serverScanned); // revert the optimistic bump
        notify(`Scan rejected: ${result.error || 'unknown error, please try again'}`);
        return;
      }

      const data = result.data as { scanned?: number } | undefined;
      const confirmed = typeof data?.scanned === 'number' ? data.scanned : optimisticNext;
      setOptimisticScanned(confirmed);
      setPhase(confirmed >= expected ? 'all-collected' : 'collected-one');
      void refetch();
    } catch (err) {
      setOptimisticScanned(serverScanned);
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.');
    } finally {
      // Every exit path above already leaves `phase` unchanged on failure,
      // so re-enabling the scanner here is always correct — this is what
      // guarantees a failed/unexpected scan never leaves the camera stuck.
      setPaused(false);
    }
  };

  if (phase === 'scanning') {
    return (
      <FullscreenSheet onClose={onClose} toast={toast}>
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
      <FullscreenSheet onClose={onClose} toast={toast}>
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
    <FullscreenSheet onClose={onClose} toast={toast}>
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
  toast,
}: {
  orderIds: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
  notify: (msg: string) => void;
  toast: string | null;
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

    try {
      const result = await submitAction('record_warehouse_arrival', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_gate_qr_value: value,
        p_order_ids: orderIds,
        p_client_captured_at: new Date().toISOString(),
      }));
      if (result.ok) {
        completeArrival((result.data as WarehouseArrivalRow[] | null) ?? []);
      } else {
        notify(`Could not record arrival: ${result.error || 'unknown error, please try again'}`);
        setPaused(false);
      }
    } catch (err) {
      notify(err instanceof Error ? `Could not record arrival: ${err.message}` : 'Could not record arrival. Please try again.');
      setPaused(false);
    }
  };

  return (
    <FullscreenSheet onClose={onClose} toast={toast}>
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

interface SortingStep {
  hole_id: string;
  hole_number: string | null;
  bags_reserved: number;
  bags_sorted: number;
  is_unlocked: boolean;
}

function SortingOrderStep({
  order,
  onOpenHole,
}: {
  order: Order;
  onOpenHole: (holeId: string, holeNumber: string) => void;
}) {
  const [steps, setSteps] = useState<SortingStep[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase.rpc('get_order_sorting_steps_v1', { p_order_id: order.id }).then(({ data, error: rpcError }) => {
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
        return;
      }
      setSteps((data as SortingStep[] | null) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [order.id, order.bag_count_scanned_sort]);

  const current = steps.find((step) => step.is_unlocked && step.bags_sorted < step.bags_reserved);
  return (
    <article className="sorting-order-card">
      <div className="sorting-order-header">
        <span className="order-number">{order.external_order_ref}</span>
        <span className="sorting-total">Dropped {order.bag_count_scanned_sort}/{order.bag_count_expected} bags</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {current && current.hole_number && (
        <button
          type="button"
          className="sorting-current-hole"
          onClick={() => onOpenHole(current.hole_id, current.hole_number!)}
        >
          <span>Head to pigeon hole:</span>
          <strong>{current.hole_number}</strong>
          <small>Dropped {current.bags_sorted}/{current.bags_reserved} bags here</small>
        </button>
      )}
      <div className="sorting-locked-holes">
        {steps.filter((step) => !step.is_unlocked).map((step, index) => (
          <span key={step.hole_id}>🔒 Next pigeon hole locked{index > 0 ? ` +${index}` : ''}</span>
        ))}
      </div>
    </article>
  );
}

type HoleDropPhase = 'verify-hole' | 'hole-arrived' | 'scan-bag' | 'bag-collected' | 'complete';

function DropIntoHoleFlow({
  orderId,
  holeId,
  holeNumber,
  onDone,
  notify,
  toast,
}: {
  orderId: string;
  holeId: string;
  holeNumber: string;
  onDone: () => Promise<void>;
  notify: (msg: string) => void;
  toast: string | null;
}) {
  const [phase, setPhase] = useState<HoleDropPhase>('verify-hole');
  const [paused, setPaused] = useState(false);
  const [holeQrValue, setHoleQrValue] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [expected, setExpected] = useState(0);

  // Both handlers are wrapped in try/catch and ALWAYS release `paused` (and
  // therefore the scanner's decode lock) on every exit path, including
  // completely unexpected ones (a thrown error, a malformed RPC response).
  // Without this, one unhandled exception here would leave `paused=true`
  // forever with no error shown — which looks exactly like "scanning the
  // bag does nothing": the camera keeps running, but every further decode
  // is silently ignored because decodeLockedRef never gets released.
  const verifyHole = async (value: string) => {
    if (paused) return;
    setPaused(true);
    try {
      const { data, error } = await supabase.rpc('verify_pigeon_hole_v1', {
        p_order_id: orderId,
        p_pigeon_hole_qr_value: value,
      });
      if (error) {
        notify(error.message || 'Could not verify this pigeon hole. Please try again.');
        return;
      }
      const step = data as { hole_id?: string; hole_number?: string; dropped?: number; expected?: number } | null;
      if (!step || typeof step.hole_id !== 'string') {
        notify('Unexpected response verifying the pigeon hole. Please try again.');
        return;
      }
      if (step.hole_id !== holeId) {
        notify('Wrong pigeon hole. Scan the currently unlocked hole for this order.');
        return;
      }
      setHoleQrValue(value);
      setDropped(step.dropped ?? 0);
      setExpected(step.expected ?? 0);
      setPhase('hole-arrived');
    } catch (err) {
      notify(err instanceof Error ? `Could not verify hole: ${err.message}` : 'Could not verify hole. Please try again.');
    } finally {
      setPaused(false);
    }
  };

  const scanBag = async (value: string) => {
    if (paused) return;
    if (!holeQrValue) {
      notify('Hole not verified yet — please scan the pigeon hole again.');
      return;
    }
    setPaused(true);
    try {
      const result = await submitAction('scan_bag_into_pigeon_hole', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_order_id: orderId,
        p_bag_qr_value: value,
        p_pigeon_hole_qr_value: holeQrValue,
        p_client_captured_at: new Date().toISOString(),
        p_device_id: navigator.userAgent.slice(0, 64),
      }));
      if (!result.ok) {
        notify(
          result.error === 'Wrong bag, bag does not belong to the hole'
            ? 'Wrong bag, bag does not belong to the hole'
            : `Scan rejected: ${result.error || 'unknown error, please try again'}`
        );
        return;
      }
      const placement = result.data as
        | { dropped?: number; expected?: number; hole_complete?: boolean }
        | undefined;
      if (!placement || typeof placement.dropped !== 'number' || typeof placement.expected !== 'number') {
        notify('Unexpected response from the server. Please try scanning that bag again.');
        return;
      }
      setDropped(placement.dropped);
      setExpected(placement.expected);
      setPhase(placement.hole_complete ? 'complete' : 'bag-collected');
      if (placement.hole_complete) {
        window.setTimeout(() => void onDone(), 1100);
      }
    } catch (err) {
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.');
    } finally {
      setPaused(false);
    }
  };

  if (phase === 'hole-arrived') {
    return (
      <FullscreenSheet onClose={() => void onDone()} toast={toast}>
        <div className="sheet-body center fade-in">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>Arrived at Pigeon Hole {holeNumber}</h2>
          <p className="sheet-sub">Start scanning bags now</p>
        </div>
        <div className="sheet-footer">
          <button type="button" className="dark-button" onClick={() => setPhase('scan-bag')}>
            Scan Bags {dropped}/{expected}
          </button>
        </div>
      </FullscreenSheet>
    );
  }

  if (phase === 'bag-collected') {
    const remaining = Math.max(expected - dropped, 0);
    return (
      <FullscreenSheet onClose={() => void onDone()} toast={toast}>
        <div className="sheet-body center fade-in">
          <h2>You have dropped Bag #{dropped}</h2>
          <p className="sheet-sub">
            This hole holds {expected} bags · <strong>{remaining}</strong> remaining, drop the next
            bag
          </p>
          <BagsGrid total={expected} collected={dropped} />
        </div>
        <div className="sheet-footer">
          <button type="button" className="dark-button" onClick={() => setPhase('scan-bag')}>
            Drop next bag
          </button>
        </div>
      </FullscreenSheet>
    );
  }

  if (phase === 'complete') {
    return (
      <FullscreenSheet onClose={() => void onDone()} toast={toast}>
        <div className="sheet-body center fade-in">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>Pigeon hole {holeNumber} complete</h2>
          <p className="sheet-sub">The next pigeon hole is now unlocked.</p>
          <BagsGrid total={expected} collected={expected} />
        </div>
      </FullscreenSheet>
    );
  }

  // 'verify-hole' | 'scan-bag'
  return (
    <FullscreenSheet onClose={() => void onDone()} toast={toast}>
      <div className="scan-heading fade-in">
        <p className="scan-order">Head to pigeon hole: {holeNumber}</p>
        <h2 className="scan-title">
          {phase === 'verify-hole' ? `Scan hole ${holeNumber}` : `Scan bag ${dropped + 1}/${expected}`}
        </h2>
        <p className="scan-sub">
          {phase === 'verify-hole'
            ? 'First scan the pigeon hole QR to confirm you are at the right location.'
            : 'Scan only bags allocated to this hole.'}
        </p>
        {phase === 'scan-bag' && (
          <p className="scan-counts">
            <strong>{dropped}</strong> dropped · <strong>{Math.max(expected - dropped, 0)}</strong> remaining
          </p>
        )}
      </div>
      {/* Deliberately the SAME QrScannerView instance (no key/remount)
          across the hole-verify and bag-scan phases — only the onDecode
          callback changes. See QrScannerView's `[paused]` effect for why
          repeatedly stopping/re-requesting the camera stream between
          phases caused a black-screen bug. */}
      <QrScannerView onDecode={phase === 'verify-hole' ? verifyHole : scanBag} paused={paused} />
    </FullscreenSheet>
  );
}
