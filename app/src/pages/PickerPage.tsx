import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOrders } from '../lib/useOrders';
import { useStoreNames } from '../lib/useStores';
import { submitAction } from '../lib/actions';
import { supabase } from '../lib/supabaseClient';
import { QrScannerView } from '../components/QrScannerView';
import { BagsGrid } from '../components/BagsGrid';
import { FullscreenSheet } from '../components/FullscreenSheet';
import { PullToRefresh } from '../components/PullToRefresh';
import { CheckIcon, PinIcon, LogoutIcon } from '../components/icons';
import type { Order } from '../types/database';
import { OrderAcceptSwipe } from '../components/OrderAcceptSwipe';
import { StatusPill } from '../components/StatusPill';
import { orderStatusMeta } from '../lib/status';
import { useToast, type Toast, type ToastVariant } from '../lib/useToast';
import { friendlyScanError } from '../lib/scanErrors';
import { alertNewOrder, primeAudio, requestNotificationPermission } from '../lib/alerts';
import { withTimeout } from '../lib/rpcTimeout';

type Screen =
  | { name: 'queue' }
  | { name: 'order-detail'; orderId: string }
  | { name: 'scan-pickup'; orderId: string }
  | { name: 'dropoff' }
  | { name: 'scan-gate' }
  | { name: 'sorting' }
  | { name: 'drop-into-hole'; orderId: string; holeId: string; holeNumber: string }
  | { name: 'choose-hole' };

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

// Small label so a picker can see which wall a shipment belongs to.
function DeliveryBadge({ order }: { order: Order }) {
  if (!order.delivery_mode) return null;
  return (
    <span className={`state-pill ${order.delivery_mode === 'LMS' ? 'tone-info' : 'tone-attention'}`}>
      {order.delivery_mode}
    </span>
  );
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
  const { profile, patchProfile, refreshProfile, signOut } = useAuth();
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

  // An order is the picker's ACTIVE work only until they finish sorting it.
  // Once sorted it becomes 'ready_for_dispatch' - the warehouse's concern, not
  // the picker's - so it is released here just like dispatched/completed. This
  // is what lets the "all sorted" screen appear and frees the picker's capacity
  // for the next order (matches picker_active_order_count_v1 on the server).
  const myOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.assigned_picker_id === profile?.id &&
          !['ready_for_dispatch', 'dispatched', 'completed', 'cancelled'].includes(o.status)
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

    // Going online is a user gesture — use it to unlock the new-order chime and
    // ask for notification permission so the picker gets alerted for new work.
    if (goingOnline) {
      primeAudio();
      void requestNotificationPermission();
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

  // Sign-out is only offered on the home screen. Confirm first, then mark the
  // picker offline before ending the session so they don't linger "online" in
  // the roster / assignment engine after leaving.
  // A picker mid-flow (picking, carrying picked-up bags, or still sorting) must
  // not sign out and abandon physical work. Only offer sign-out when idle.
  const hasActiveWork = inProgress.length > 0 || pickedUp.length > 0 || inSorting.length > 0;

  const handleSignOut = async () => {
    if (hasActiveWork) {
      notify('Finish and drop off your current orders before signing out.', 'error');
      return;
    }
    if (!window.confirm('Sign out of Dubai Mall Ops? You will be marked offline and stop receiving orders.')) {
      return;
    }
    try {
      await supabase.rpc('set_picker_status_v1', { p_is_online: false });
    } catch {
      // Even if the offline call fails, still sign out.
    }
    await signOut();
  };

  // Auto-focus the In progress tab only when work FIRST appears (a rising
  // edge), not on every render where work exists - otherwise a picker who taps
  // another tab is yanked back to In progress on the next data refresh.
  const hadInProgress = useRef(false);
  useEffect(() => {
    if (inProgress.length > 0 && !hadInProgress.current) setActiveTab('in_progress');
    hadInProgress.current = inProgress.length > 0;
  }, [inProgress.length]);

  // Ring + notify when a NEW order lands in the picker's queue. Seed the set of
  // known order ids on first run so we never alert for orders that were already
  // there when the screen opened - only genuinely new assignments chime.
  const knownOrderIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const currentIds = new Set(myOrders.map((o) => o.id));
    if (knownOrderIds.current === null) {
      knownOrderIds.current = currentIds;
      return;
    }
    const fresh = myOrders.filter((o) => !knownOrderIds.current!.has(o.id));
    knownOrderIds.current = currentIds;
    if (fresh.length > 0) {
      const first = fresh[0];
      const label = fresh.length === 1 ? first.external_order_ref : `${fresh.length} new orders`;
      alertNewOrder('New order assigned', `${label} - ${first.bag_count_expected} bag(s) to pick up`);
    }
  }, [myOrders]);

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
      <PullToRefresh onRefresh={refetch}>
      <div
        className="picker-screen"
        ref={screenRef}
        style={handoffBarHeight ? { paddingBottom: handoffBarHeight + 24 } : undefined}
      >
        <PickerHeader
          profile={profile}
          busy={onlineToggleBusy}
          onToggleOnline={() => void toggleOnline()}
          onSignOut={() => void handleSignOut()}
          signOutBlocked={hasActiveWork}
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
      </PullToRefresh>
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
          {/* "All sorted" only when the picker has NO active orders left at all
              (everything assigned to them is dispatched). If they still have
              orders to pick up or drop off, we don't claim they're done. */}
          {inSorting.length === 0 &&
            (myOrders.length === 0 ? (
              <div className="done-state fade-in">
                <div className="success-checkmark">
                  <CheckIcon />
                </div>
                <h2>All sorted</h2>
                <p className="sheet-sub">Every order assigned to you is in its pigeon hole. Nothing left to sort.</p>
                <button type="button" className="dark-button done-state-cta" onClick={() => setScreen({ name: 'queue' })}>
                  Pick more orders
                </button>
              </div>
            ) : (
              <div className="done-state fade-in">
                <h2>Nothing to sort right now</h2>
                <p className="sheet-sub">
                  You still have {myOrders.length} order{myOrders.length === 1 ? '' : 's'} to pick up or drop off. Head back to your queue.
                </p>
                <button type="button" className="dark-button done-state-cta" onClick={() => setScreen({ name: 'queue' })}>
                  Back to queue
                </button>
              </div>
            ))}
          {inSorting.length > 0 &&
            (holeMode === 'picker_chosen' ? (
              // Picker-chosen: the picker decides which order goes in which hole,
              // so we show generic sequential steps (one per order still to
              // sort) rather than naming orders. Only the first is actionable.
              <SortStepList count={inSorting.length} onStart={() => setScreen({ name: 'choose-hole' })} />
            ) : (
              inSorting.map((o) => (
                <SortingOrderStep
                  key={o.id}
                  order={o}
                  onOpenHole={(holeId, holeNumber) =>
                    setScreen({ name: 'drop-into-hole', orderId: o.id, holeId, holeNumber })
                  }
                />
              ))
            ))}
        </div>
      </div>
    );
  }

  if (screen.name === 'choose-hole') {
    return (
      <ChooseHoleAndDropFlow
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
  onSignOut,
  signOutBlocked,
}: {
  profile: ReturnType<typeof useAuth>['profile'];
  busy: boolean;
  onToggleOnline: () => void;
  onSignOut: () => void;
  signOutBlocked: boolean;
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
      {/* Sign-out lives only on the home screen. It's disabled while the picker
          has active work (in-progress / picked-up / still sorting) so they can't
          abandon physical orders mid-flow. */}
      <button
        type="button"
        className={`icon-button picker-signout${signOutBlocked ? ' is-disabled' : ''}`}
        onClick={onSignOut}
        aria-disabled={signOutBlocked}
        aria-label="Sign out"
        title={signOutBlocked ? 'Finish and drop off your orders before signing out' : 'Sign out'}
      >
        <LogoutIcon />
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
        <DeliveryBadge order={order} />
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
        notify(friendlyScanError('pickup', result.error, order.delivery_mode), 'error');
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
    }
    // No scanner re-arming needed here: QrScannerView owns that and always
    // re-arms after this promise settles. On failure `phase` is unchanged, so
    // the scanner stays mounted and simply keeps scanning for the next code.
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
        <QrScannerView onDecode={handleDecode} />
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
          <button type="button" className="dark-button" onClick={() => setPhase('scanning')}>
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
        {!oneBag && (
          <div className="success-checkmark">
            <CheckIcon />
          </div>
        )}
        <h2>{oneBag ? 'Confirm your bags' : 'All bags collected'}</h2>
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
    try {
      const arrival = await submitAction(
        pickerChosen ? 'record_warehouse_arrival_picker_chosen' : 'record_warehouse_arrival',
        (clientEventId) => ({
          p_client_event_id: clientEventId,
          p_gate_qr_value: value,
          p_order_ids: orderIds,
          p_client_captured_at: new Date().toISOString(),
        }),
      );
      if (arrival.ok) {
        // Setting `result` unmounts the scanner immediately, so no second gate
        // scan can fire during the short hand-off delay.
        completeArrival((arrival.data as WarehouseArrivalRow[] | null) ?? []);
      } else {
        notify(friendlyScanError('gate', arrival.error), 'error');
      }
    } catch (err) {
      notify(
        err instanceof Error ? friendlyScanError('gate', err.message) : 'Could not record arrival. Please try again.',
        'error',
      );
    }
  };

  return (
    <FullscreenSheet onClose={onClose} toast={toast}>
      <div className="scan-heading fade-in">
        <h2 className="scan-title">Scan warehouse gate</h2>
        <p className="scan-sub">Scan the QR code at the warehouse entrance to arrive</p>
      </div>
      {!result && <QrScannerView onDecode={handleDecode} />}
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
        <DeliveryBadge order={order} />
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

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// Picker-chosen sorting: the picker decides which order goes in which hole, so
// we don't name orders. We show one sequential step per order still to sort;
// only the first is actionable, the rest stay locked until earlier steps are
// done (they simply disappear as each order is sorted, since `count` drops).
function SortStepList({ count, onStart }: { count: number; onStart: () => void }) {
  return (
    <div className="sort-steps">
      {Array.from({ length: count }, (_, i) => {
        const active = i === 0;
        return (
          <button
            key={i}
            type="button"
            className={`sort-step${active ? '' : ' is-locked'}`}
            onClick={active ? onStart : undefined}
            aria-disabled={!active}
          >
            <span className="sort-step-title">Scan a hole to place {ordinal(i + 1)} order</span>
            <small>
              {active
                ? 'Scan any empty hole, then scan that order’s bag(s).'
                : 'Locked until the previous order is sorted.'}
            </small>
            {!active && <span className="sort-step-lock" aria-hidden="true">🔒</span>}
          </button>
        );
      })}
    </div>
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
  const [holeQrValue, setHoleQrValue] = useState<string | null>(null);
  const [dropped, setDropped] = useState(0);
  const [expected, setExpected] = useState(0);

  // Both handlers are async and are awaited by QrScannerView, which serialises
  // decodes and always re-arms when the promise settles (see its reliability
  // contract). Neither handler needs to gate the scanner itself, so a wrong
  // scan simply shows an error and the scanner keeps looking for the next code.
  const verifyHole = async (value: string) => {
    try {
      const { data, error } = await supabase.rpc('verify_pigeon_hole_v1', {
        p_order_id: orderId,
        p_pigeon_hole_qr_value: value,
      });
      if (error) {
        notify(friendlyScanError('verify-hole', error.message), 'error');
        return;
      }
      const step = data as { hole_id?: string; hole_number?: string; dropped?: number; expected?: number } | null;
      if (!step || typeof step.hole_id !== 'string') {
        notify('Unexpected response verifying the pigeon hole. Please try again.', 'error');
        return;
      }
      if (step.hole_id !== holeId) {
        notify(`Wrong hole - please scan the highlighted hole (${holeNumber}) for this order.`, 'error');
        return;
      }
      setHoleQrValue(value);
      setDropped(step.dropped ?? 0);
      setExpected(step.expected ?? 0);
      setPhase('hole-arrived');
    } catch (err) {
      notify(err instanceof Error ? `Could not verify hole: ${err.message}` : 'Could not verify hole. Please try again.', 'error');
    }
  };

  const scanBag = async (value: string) => {
    if (!holeQrValue) {
      notify('Hole not verified yet — please scan the pigeon hole again.', 'error');
      return;
    }
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
        notify(friendlyScanError('sort-bag', result.error), 'error');
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
      {/* Same screen serves both the hole-verify and bag-scan phases; only the
          onDecode callback swaps, so no `key` is set that would force an extra
          camera teardown/re-request within a phase. */}
      <QrScannerView onDecode={phase === 'verify-hole' ? verifyHole : scanBag} />
    </FullscreenSheet>
  );
}

type ChooseHolePhase = 'scan-hole' | 'hole-held' | 'scan-bag' | 'bag-collected' | 'complete';

// Picker-chosen sorting (order-agnostic). The picker scans ANY free hole to
// hold it, then scans a bag; the BAG identifies which order this is (there is
// no pre-allocation of order -> hole). The first bag links the hole to that
// order and the delivery-mode wall gate is enforced then. Works in both
// bag-scan modes.
function ChooseHoleAndDropFlow({
  onDone,
  notify,
  toast,
}: {
  onDone: () => Promise<void>;
  notify: (msg: string, variant?: ToastVariant) => void;
  toast: Toast | null;
}) {
  const scanMode = useBagScanMode();
  const oneBag = scanMode === 'one_bag';
  const [phase, setPhase] = useState<ChooseHolePhase>('scan-hole');
  const [hole, setHole] = useState<{ id: string; number: string; qr: string } | null>(null);
  const [dropped, setDropped] = useState(0);
  // Unknown until the first bag scan reveals which order (and its bag count).
  const [expected, setExpected] = useState(0);
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const placedRef = useRef(false);

  const closeFlow = () => {
    // Free the hold if no bag was placed yet, so an abandoned hole doesn't stay
    // locked. A hole already linked to an order is untouched by this call.
    if (!placedRef.current) void supabase.rpc('release_held_hole_v1');
    void onDone();
  };

  const claimHole = async (value: string) => {
    try {
      // No order id: the hole is just held; the bag will decide the order.
      const { data, error } = await withTimeout(
        supabase.rpc('claim_pigeon_hole_v1', { p_hole_qr_value: value }),
      );
      if (error) {
        notify(friendlyScanError('claim-hole', error.message), 'error');
        return;
      }
      const held = data as { hole_id?: string; hole_number?: string } | null;
      if (!held || typeof held.hole_id !== 'string' || typeof held.hole_number !== 'string') {
        notify('Unexpected response claiming the hole. Please try again.', 'error');
        return;
      }
      setHole({ id: held.hole_id, number: held.hole_number, qr: value });
      // A deliberate "hole on hold" screen unmounts the scanner between the hole
      // scan and the bag scan so the still-visible hole QR can't be read again
      // as a (rejected) bag scan.
      setPhase('hole-held');
    } catch (err) {
      notify(err instanceof Error ? `Could not use this hole: ${err.message}` : 'Could not use this hole. Please try again.', 'error');
    }
  };

  const placeBag = async (value: string) => {
    if (!hole) return;
    try {
      const result = await submitAction('scan_bag_into_held_hole', (clientEventId) => ({
        p_client_event_id: clientEventId,
        p_bag_qr_value: value,
        p_pigeon_hole_qr_value: hole.qr,
        p_client_captured_at: new Date().toISOString(),
        p_device_id: navigator.userAgent.slice(0, 64),
      }));
      if (!result.ok) {
        notify(friendlyScanError('chosen-bag', result.error), 'error');
        // A wall mismatch before any bag has been placed means this hole is on
        // the wrong wall for that order. Release it and send the picker back to
        // scan a hole on the correct wall instead of leaving them stuck.
        if (!placedRef.current && (result.error ?? '').toLowerCase().includes('wall')) {
          void supabase.rpc('release_held_hole_v1');
          setHole(null);
          setPhase('scan-hole');
        }
        return;
      }
      const placement = result.data as
        | { dropped?: number; expected?: number; hole_complete?: boolean; order_ref?: string }
        | undefined;
      if (!placement || typeof placement.dropped !== 'number' || typeof placement.expected !== 'number') {
        notify('Unexpected response from the server. Please try scanning that bag again.', 'error');
        return;
      }
      placedRef.current = true;
      if (placement.order_ref) setOrderRef(placement.order_ref);
      setDropped(placement.dropped);
      setExpected(placement.expected);
      setPhase(placement.hole_complete ? 'complete' : 'bag-collected');
      if (placement.hole_complete && !oneBag) {
        window.setTimeout(() => void onDone(), 1100);
      }
    } catch (err) {
      notify(err instanceof Error ? `Scan failed: ${err.message}` : 'Scan failed unexpectedly. Please try again.', 'error');
    }
  };

  if (phase === 'bag-collected') {
    const remaining = Math.max(expected - dropped, 0);
    return (
      <FullscreenSheet onClose={closeFlow} toast={toast}>
        <div className="sheet-body center fade-in">
          <h2>You have placed Bag #{dropped}</h2>
          <p className="sheet-sub">
            This order has {expected} bags · <strong>{remaining}</strong> remaining, all in hole {hole?.number}
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
              ? `Scan any one bag of the order you want to place in hole ${hole?.number}.`
              : `Scan the bags of the order you want to place in hole ${hole?.number}.`}
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
              <>{orderRef ? `${orderRef} sorted` : 'Order sorted'} and ready for dispatch.</>
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
        <p className="scan-order">Place an order in a pigeon hole</p>
        <h2 className="scan-title">
          {scanningBag ? `Scan a bag to place in ${hole?.number}` : 'Scan a pigeon hole'}
        </h2>
        <p className="scan-sub">
          {!scanningBag
            ? 'Scan any empty hole to hold it, then scan the order you want to place there.'
            : `Scan the bag(s) of the order you are placing in hole ${hole?.number}. The first bag locks that order to this hole.`}
        </p>
        {scanningBag && expected > 0 && (
          <p className="scan-counts">
            <strong>{dropped}</strong> placed · <strong>{Math.max(expected - dropped, 0)}</strong> remaining
          </p>
        )}
      </div>
      <QrScannerView onDecode={scanningBag ? placeBag : claimHole} />
    </FullscreenSheet>
  );
}
