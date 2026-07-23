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
import { StatusPill } from '../components/StatusPill';
import { orderStatusMeta } from '../lib/status';
import { useToast, type Toast, type ToastVariant } from '../lib/useToast';

type Screen =
  | { name: 'queue' }
  | { name: 'order-detail'; orderId: string }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'drop-into-hole'; orderId: string; holeId: string; holeNumber: string }
  | { name: 'choose-hole'; orderId: string };

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

type BagScanMode = 'all_bags' | 'one_bag';

// Reads the operations-wide bag scan mode. operations_configuration is
// admin-only via RLS, so pickers learn the mode through the SECURITY DEFINER
// get_bag_scan_mode_v1 reader. Defaults to 'all_bags' if the RPC is missing
// (migration 0014 not yet applied) so the picker flow keeps working.
function useBagScanMode(): BagScanMode {
  const [mode, setMode] = useState<BagScanMode>('all_bags');
  useEffect(() => {
    let active = true;
    void supabase.rpc('get_bag_scan_mode_v1').then(({ data }) => {
      if (active && (data === 'one_bag' || data === 'all_bags')) setMode(data);
    });
    return () => {
      active = false;
    };
  }, []);
  return mode;
}

type HoleAssignmentMode = 'pre_assigned' | 'picker_chosen';

// Reads the operations-wide pigeon-hole assignment mode (migration 0015).
// Defaults to 'pre_assigned' if the reader RPC is missing so the existing flow
// keeps working on an un-migrated project.
function useHoleAssignmentMode(): HoleAssignmentMode {
  const [mode, setMode] = useState<HoleAssignmentMode>('pre_assigned');
  useEffect(() => {
    let active = true;
    void supabase.rpc('get_hole_assignment_mode_v1').then(({ data }) => {
      if (active && (data === 'picker_chosen' || data === 'pre_assigned')) setMode(data);
    });
    return () => {
      active = false;
    };
  }, []);
  return mode;
}

export function PickerPage() {
  const { profile, patchProfile, refreshProfile } = useAuth();
  const { orders, refetch } = useOrders();
  const storeNames = useStoreNames();
  const [screen, setScreen] = useState<Screen>({ name: 'queue' });
  const [activeTab, setActiveTab] = useState<QueueTab>('pending');
  const { toast, notify } = useToast(4000);
  const [onlineToggleBusy, setOnlineToggleBusy] = useState(false);
  const holeMode = useHoleAssignmentMode();

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

  const toggleOnline = async () => {
    const goingOnline = !profile?.is_online;
    if (!goingOnline && inProgress.length > 0) {
      notify('Finish your in-progress order before going offline.', 'error');
      return;
    }
    if (!goingOnline && pickedUp.length > 0) {
      notify(`Drop off ${pickedUp.length} picked-up order(s) before going offline.`, 'error');
      return;
    }

    setOnlineToggleBusy(true);
    patchProfile({ is_online: goingOnline });
    const { error } = await supabase.rpc('set_picker_status_v1', { p_is_online: goingOnline });
    setOnlineToggleBusy(false);
    if (error) {
      patchProfile({ is_online: !goingOnline });
      notify(`Could not update status: ${error.message}`, 'error');
      return;
    }
    notify(goingOnline ? 'You are now online' : 'You are now offline', 'success');
    void refreshProfile();
  };

  // Auto-focus the In progress tab only when work FIRST appears (a rising
  // edge), not on every render where work exists - otherwise a picker who taps
  // another tab is yanked back to In progress on the next data refresh.
  const hadInProgress = useRef(false);
  useEffect(() => {
    if (inProgress.length > 0 && !hadInProgress.current) setActiveTab('in_progress');
    hadInProgress.current = inProgress.length > 0;
  }, [inProgress.length]);

  const acceptOrder = async (order: Order) => {
    const result = await submitAction('accept_order', () => ({ p_order_id: order.id }));
    if (!result.ok) {
      notify(`Could not accept this order: ${result.error}`, 'error');
      return;
    }
    await refetch();
    setActiveTab('in_progress');
    setScreen({ name: 'order-detail', orderId: order.id });
  };

  const goToStore = async (order: Order) => {
    const { error } = await supabase.rpc('picker_go_to_store_v1', { p_order_id: order.id });
    if (error) {
      notify(`Cannot start this store: ${error.message}`, 'error');
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
        <PickerHeader
          profile={profile}
          busy={onlineToggleBusy}
          onToggleOnline={() => void toggleOnline()}
        />

        {toast && <div className={`toast is-${toast.variant}`} role="alert">{toast.text}</div>}

        {!profile?.is_online ? (
          <div className="offline-banner" role="status">
            <span aria-hidden="true">●</span>
            <span>
              Offline - not receiving new orders.
              {myOrders.length > 0 ? ' Finish any assigned work below, then go online again.' : ' Go online to start receiving orders.'}
            </span>
          </div>
        ) : null}

        {(profile?.is_online || myOrders.length > 0) && (
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
        )}
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
            <StatusPill meta={orderStatusMeta(order.status)} />
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
        holeMode={holeMode}
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
          {inSorting.map((o) =>
            holeMode === 'picker_chosen' ? (
              <ChooseHoleStep
                key={o.id}
                order={o}
                onChooseHole={() => setScreen({ name: 'choose-hole', orderId: o.id })}
              />
            ) : (
              <SortingOrderStep
                key={o.id}
                order={o}
                onOpenHole={(holeId, holeNumber) =>
                  setScreen({ name: 'drop-into-hole', orderId: o.id, holeId, holeNumber })
                }
              />
            ),
          )}
        </div>
      </div>
    );
  }

  if (screen.name === 'choose-hole') {
    const order = orders.find((o) => o.id === screen.orderId);
    return (
      <ChooseHoleAndDropFlow
        order={order}
        onDone={async () => {
          await refetch();
          setScreen({ name: 'sorting' });
        }}
        notify={notify}
        toast={toast}
      />
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
      <h1 className="picker-title">Pending Pickup</h1>
      <button
        type="button"
        className={`online-toggle ${online ? 'is-online' : ''}`}
        onClick={onToggleOnline}
        disabled={busy}
        aria-pressed={online}
        aria-label={online ? 'Go offline' : 'Go online'}
      >
        {busy && <span className="button-spinner" aria-hidden="true" />}
        {online ? 'Online' : 'Offline'}
        <span className="online-dot">{online ? <CheckIcon /> : null}</span>
      </button>
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
  return (
    <article className={`order-card${order.is_fragile ? ' is-fragile' : ''}`}>
      <div className="order-card-head">
        <span className="order-number">{order.external_order_ref}</span>
        <StatusPill meta={orderStatusMeta(order.status)} />
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
  notify: (msg: string, variant?: ToastVariant) => void;
  toast: Toast | null;
  refetch: () => Promise<void>;
}) {
  const scanMode = useBagScanMode();
  const oneBag = scanMode === 'one_bag';
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
        notify(`Scan rejected: ${result.error || 'unknown error, please try again'}`, 'error');
        return;
      }

      const data = result.data as { scanned?: number } | undefined;
      const confirmed = typeof data?.scanned === 'number' ? data.scanned : optimisticNext;
      setOptimisticScanned(confirmed);
      setPhase(confirmed >= expected ? 'all-collected' : 'collected-one');
      void refetch();
    } catch (err) {
      setOptimisticScanned(serverScanned);
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.', 'error');
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
          <p className="scan-sub">
            {oneBag
              ? 'Scan any one bag to confirm this whole shipment'
              : 'Scan the QR code on the order bag'}
          </p>
          {oneBag ? (
            <p className="scan-progress">One scan confirms all {expected} bags</p>
          ) : (
            <p className="scan-progress">
              Collecting Bag {Math.min(scanned + 1, expected)}/{expected}
            </p>
          )}
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

  // all-collected. In one_bag mode a single scan marked every bag, so we ask
  // the picker to physically confirm the bag count before finishing.
  return (
    <FullscreenSheet onClose={onClose} toast={toast}>
      <div className="sheet-body center fade-in">
        <h2>{oneBag ? 'Confirm your bags' : 'You have collected all the bags!'}</h2>
        <p className="sheet-sub">
          {oneBag ? (
            <>Please ensure you have picked up <strong>{expected}</strong> bags</>
          ) : (
            <><strong>{expected}</strong> of {expected} bags picked up</>
          )}
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
          {oneBag ? `Confirm ${expected} bags` : 'Done!'}
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
  holeMode,
  onClose,
  onDone,
  notify,
  toast,
}: {
  orderIds: string[];
  holeMode: HoleAssignmentMode;
  onClose: () => void;
  onDone: () => Promise<void>;
  notify: (msg: string, variant?: ToastVariant) => void;
  toast: Toast | null;
}) {
  const pickerChosen = holeMode === 'picker_chosen';
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<WarehouseArrivalRow[] | null>(null);

  const completeArrival = (rows: WarehouseArrivalRow[]) => {
    setResult(rows);
    if (pickerChosen) {
      notify('Arrived. Choose a pigeon hole for each shipment at the wall.', 'success');
    } else {
      const overflow = rows.filter((row) => !row.reserved);
      if (overflow.length > 0) {
        notify(`${overflow.length} order(s) have no free hole yet — hold those bags for staging.`, 'error');
      } else {
        notify('Pigeon holes assigned. Continue to sorting.', 'success');
      }
    }
    window.setTimeout(() => {
      void onDone();
    }, 900);
  };

  const handleDecode = async (value: string) => {
    if (paused) return;
    setPaused(true);

    try {
      const result = await submitAction(
        pickerChosen ? 'record_warehouse_arrival_picker_chosen' : 'record_warehouse_arrival',
        (clientEventId) => ({
          p_client_event_id: clientEventId,
          p_gate_qr_value: value,
          p_order_ids: orderIds,
          p_client_captured_at: new Date().toISOString(),
        }),
      );
      if (result.ok) {
        completeArrival((result.data as WarehouseArrivalRow[] | null) ?? []);
      } else {
        notify(`Could not record arrival: ${result.error || 'unknown error, please try again'}`, 'error');
        setPaused(false);
      }
    } catch (err) {
      notify(err instanceof Error ? `Could not record arrival: ${err.message}` : 'Could not record arrival. Please try again.', 'error');
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
              {pickerChosen
                ? 'Arrived - choose a hole at the wall'
                : r.reserved
                  ? `Go to hole ${r.pigeon_hole_number}`
                  : 'No hole yet — hold in staging'}
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
          <span key={step.hole_id}>Next pigeon hole locked{index > 0 ? ` (${index + 1})` : ''}</span>
        ))}
      </div>
    </article>
  );
}

// Picker-chosen mode: no hole is pre-assigned, so the sort card just launches
// the "scan a hole, then scan bags into it" flow.
function ChooseHoleStep({
  order,
  onChooseHole,
}: {
  order: Order;
  onChooseHole: () => void;
}) {
  const started = order.pigeon_hole_id != null;
  return (
    <article className="sorting-order-card">
      <div className="sorting-order-header">
        <span className="order-number">{order.external_order_ref}</span>
        <span className="sorting-total">Dropped {order.bag_count_scanned_sort}/{order.bag_count_expected} bags</span>
      </div>
      <button type="button" className="sorting-current-hole" onClick={onChooseHole}>
        <span>{started ? 'Continue placing bags' : 'Choose a pigeon hole'}</span>
        <strong>{started ? 'Re-scan your hole' : 'Scan any free hole'}</strong>
        <small>
          {started
            ? 'All bags for this shipment go in the same hole.'
            : 'The hole locks to this shipment on the first bag.'}
        </small>
      </button>
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
  notify: (msg: string, variant?: ToastVariant) => void;
  toast: Toast | null;
}) {
  const scanMode = useBagScanMode();
  const oneBag = scanMode === 'one_bag';
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
        notify(error.message || 'Could not verify this pigeon hole. Please try again.', 'error');
        return;
      }
      const step = data as { hole_id?: string; hole_number?: string; dropped?: number; expected?: number } | null;
      if (!step || typeof step.hole_id !== 'string') {
        notify('Unexpected response verifying the pigeon hole. Please try again.', 'error');
        return;
      }
      if (step.hole_id !== holeId) {
        notify('Wrong pigeon hole. Scan the currently unlocked hole for this order.', 'error');
        return;
      }
      setHoleQrValue(value);
      setDropped(step.dropped ?? 0);
      setExpected(step.expected ?? 0);
      setPhase('hole-arrived');
    } catch (err) {
      notify(err instanceof Error ? `Could not verify hole: ${err.message}` : 'Could not verify hole. Please try again.', 'error');
    } finally {
      setPaused(false);
    }
  };

  const scanBag = async (value: string) => {
    if (paused) return;
    if (!holeQrValue) {
      notify('Hole not verified yet — please scan the pigeon hole again.', 'error');
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
            : `Scan rejected: ${result.error || 'unknown error, please try again'}`,
          'error',
        );
        return;
      }
      const placement = result.data as
        | { dropped?: number; expected?: number; hole_complete?: boolean }
        | undefined;
      if (!placement || typeof placement.dropped !== 'number' || typeof placement.expected !== 'number') {
        notify('Unexpected response from the server. Please try scanning that bag again.', 'error');
        return;
      }
      setDropped(placement.dropped);
      setExpected(placement.expected);
      setPhase(placement.hole_complete ? 'complete' : 'bag-collected');
      // In one_bag mode the picker must confirm the bag count on the complete
      // screen, so don't auto-advance there.
      if (placement.hole_complete && !oneBag) {
        window.setTimeout(() => void onDone(), 1100);
      }
    } catch (err) {
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.', 'error');
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
            {expected > 0 ? `Scan Bags ${dropped}/${expected}` : 'Scan Bags'}
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
          <h2>{oneBag ? 'Confirm your bags' : `Pigeon hole ${holeNumber} complete`}</h2>
          <p className="sheet-sub">
            {oneBag ? (
              <>Please ensure you have placed <strong>{expected}</strong> bags in hole {holeNumber}</>
            ) : (
              'The next pigeon hole is now unlocked.'
            )}
          </p>
          <BagsGrid total={expected} collected={expected} />
        </div>
        {oneBag && (
          <div className="sheet-footer">
            <button type="button" className="dark-button" onClick={() => void onDone()}>
              Confirm {expected} bags
            </button>
          </div>
        )}
      </FullscreenSheet>
    );
  }

  // 'verify-hole' | 'scan-bag'
  return (
    <FullscreenSheet onClose={() => void onDone()} toast={toast}>
      <div className="scan-heading fade-in">
        <p className="scan-order">Head to pigeon hole: {holeNumber}</p>
        <h2 className="scan-title">
          {phase === 'verify-hole'
            ? `Scan hole ${holeNumber}`
            : oneBag
              ? 'Scan one bag to finish'
              : `Scan bag ${dropped + 1}/${expected}`}
        </h2>
        <p className="scan-sub">
          {phase === 'verify-hole'
            ? 'First scan the pigeon hole QR to confirm you are at the right location.'
            : oneBag
              ? 'Scanning any one bag here confirms the whole shipment.'
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

type ChooseHolePhase = 'scan-hole' | 'hole-held' | 'scan-bag' | 'bag-collected' | 'complete';

// Picker-chosen sorting: scan any free hole to hold it, then scan bag(s). The
// first bag links the hole to this shipment (server-enforced); only this
// shipment's bags may go in it. Works in both bag-scan modes.
function ChooseHoleAndDropFlow({
  order,
  onDone,
  notify,
  toast,
}: {
  order: Order | undefined;
  onDone: () => Promise<void>;
  notify: (msg: string, variant?: ToastVariant) => void;
  toast: Toast | null;
}) {
  const scanMode = useBagScanMode();
  const oneBag = scanMode === 'one_bag';
  const [phase, setPhase] = useState<ChooseHolePhase>('scan-hole');
  const [paused, setPaused] = useState(false);
  const [hole, setHole] = useState<{ id: string; number: string; qr: string } | null>(null);
  const [dropped, setDropped] = useState(0);
  const [expected, setExpected] = useState(order?.bag_count_expected ?? 0);
  const placedRef = useRef(false);

  const closeFlow = () => {
    // Free the hold if no bag was placed yet, so an abandoned hole doesn't stay
    // locked. A hole already linked to a shipment is untouched by this call.
    if (!placedRef.current) void supabase.rpc('release_held_hole_v1');
    void onDone();
  };

  if (!order) {
    return (
      <FullscreenSheet onClose={() => void onDone()} toast={toast}>
        <div className="empty-state">This shipment is no longer available.</div>
      </FullscreenSheet>
    );
  }

  const claimHole = async (value: string) => {
    if (paused) return;
    setPaused(true);
    try {
      const { data, error } = await supabase.rpc('claim_pigeon_hole_v1', {
        p_hole_qr_value: value,
        p_order_id: order.id,
      });
      if (error) {
        notify(error.message || 'Could not use this hole. Scan another free hole.', 'error');
        return;
      }
      const held = data as { hole_id?: string; hole_number?: string } | null;
      if (!held || typeof held.hole_id !== 'string' || typeof held.hole_number !== 'string') {
        notify('Unexpected response claiming the hole. Please try again.', 'error');
        return;
      }
      setHole({ id: held.hole_id, number: held.hole_number, qr: value });
      // Move to a deliberate "hole on hold" screen. This breaks the camera
      // between the hole scan and the bag scan so the still-visible hole QR
      // can't immediately re-fire as a (rejected) bag scan and freeze the flow.
      setPhase('hole-held');
    } catch (err) {
      notify(err instanceof Error ? `Could not use this hole: ${err.message}` : 'Could not use this hole. Please try again.', 'error');
    } finally {
      setPaused(false);
    }
  };

  const placeBag = async (value: string) => {
    if (paused || !hole) return;
    setPaused(true);
    try {
      const result = await submitAction('scan_bag_into_chosen_hole', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_order_id: order.id,
        p_bag_qr_value: value,
        p_pigeon_hole_qr_value: hole.qr,
        p_client_captured_at: new Date().toISOString(),
        p_device_id: navigator.userAgent.slice(0, 64),
      }));
      if (!result.ok) {
        notify(`Scan rejected: ${result.error || 'unknown error, please try again'}`, 'error');
        return;
      }
      const placement = result.data as
        | { dropped?: number; expected?: number; hole_complete?: boolean }
        | undefined;
      if (!placement || typeof placement.dropped !== 'number' || typeof placement.expected !== 'number') {
        notify('Unexpected response from the server. Please try scanning that bag again.', 'error');
        return;
      }
      placedRef.current = true;
      setDropped(placement.dropped);
      setExpected(placement.expected);
      setPhase(placement.hole_complete ? 'complete' : 'bag-collected');
      if (placement.hole_complete && !oneBag) {
        window.setTimeout(() => void onDone(), 1100);
      }
    } catch (err) {
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.', 'error');
    } finally {
      setPaused(false);
    }
  };

  if (phase === 'bag-collected') {
    const remaining = Math.max(expected - dropped, 0);
    return (
      <FullscreenSheet onClose={closeFlow} toast={toast}>
        <div className="sheet-body center fade-in">
          <h2>You have placed Bag #{dropped}</h2>
          <p className="sheet-sub">
            This shipment has {expected} bags · <strong>{remaining}</strong> remaining, all in hole {hole?.number}
          </p>
          <BagsGrid total={expected} collected={dropped} />
        </div>
        <div className="sheet-footer">
          <button type="button" className="dark-button" onClick={() => setPhase('scan-bag')}>
            Place next bag
          </button>
        </div>
      </FullscreenSheet>
    );
  }

  if (phase === 'hole-held') {
    return (
      <FullscreenSheet onClose={closeFlow} toast={toast}>
        <div className="sheet-body center fade-in">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>Hole {hole?.number} is on hold</h2>
          <p className="sheet-sub">
            {oneBag
              ? `Scan any one bag to place this shipment in hole ${hole?.number}.`
              : `Scan the ${expected} bags for this shipment into hole ${hole?.number}.`}
          </p>
        </div>
        <div className="sheet-footer">
          <button type="button" className="dark-button" onClick={() => setPhase('scan-bag')}>
            Scan a bag
          </button>
        </div>
      </FullscreenSheet>
    );
  }

  if (phase === 'complete') {
    return (
      <FullscreenSheet onClose={closeFlow} toast={toast}>
        <div className="sheet-body center fade-in">
          <div className="success-checkmark">
            <CheckIcon />
          </div>
          <h2>{oneBag ? 'Confirm your bags' : `Placed in hole ${hole?.number}`}</h2>
          <p className="sheet-sub">
            {oneBag ? (
              <>Please ensure you have placed <strong>{expected}</strong> bags in hole {hole?.number}</>
            ) : (
              'Shipment sorted and ready for dispatch.'
            )}
          </p>
          <BagsGrid total={expected} collected={expected} />
        </div>
        {oneBag && (
          <div className="sheet-footer">
            <button type="button" className="dark-button" onClick={() => void onDone()}>
              Confirm {expected} bags
            </button>
          </div>
        )}
      </FullscreenSheet>
    );
  }

  // 'scan-hole' | 'scan-bag' — one camera; the deliberate 'hole-held' screen
  // above separates the two so a lingering hole QR can't fire as a bag scan.
  const scanningBag = phase === 'scan-bag';
  return (
    <FullscreenSheet onClose={closeFlow} toast={toast}>
      <div className="scan-heading fade-in">
        <p className="scan-order">Sorting {order.external_order_ref}</p>
        <h2 className="scan-title">
          {scanningBag ? `Scan a bag to place in ${hole?.number}` : 'Scan a pigeon hole'}
        </h2>
        <p className="scan-sub">
          {!scanningBag
            ? 'Scan any empty hole to hold it for this shipment.'
            : oneBag
              ? `Scanning one bag places the whole shipment in hole ${hole?.number}.`
              : `All ${expected} bags for this shipment go in hole ${hole?.number}.`}
        </p>
        {scanningBag && (
          <p className="scan-counts">
            <strong>{dropped}</strong> placed · <strong>{Math.max(expected - dropped, 0)}</strong> remaining
          </p>
        )}
      </div>
      <QrScannerView onDecode={scanningBag ? placeBag : claimHole} paused={paused} />
    </FullscreenSheet>
  );
}
