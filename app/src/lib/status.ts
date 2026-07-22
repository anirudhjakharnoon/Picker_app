import type { OrderStatus, PigeonHoleStatus, UserStatus } from '../types/database';

// Functional status tones. Each maps to a `.tone-*` class in styles.css that
// carries a colour (green/blue/amber/red/grey). Colour is meaning only; every
// pill still shows a text label, so it survives colour-blind / high-glare use.
export type StatusTone = 'success' | 'info' | 'attention' | 'danger' | 'neutral';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

// One source of truth for order status -> human label + colour, used by the
// picker queue, order detail, and the admin live-orders list so a status can
// never silently fall through to the wrong colour or label.
const ORDER_STATUS_META: Record<OrderStatus, StatusMeta> = {
  ingested: { label: 'Ingested', tone: 'neutral' },
  available: { label: 'Unassigned', tone: 'attention' },
  assigned: { label: 'To pick up', tone: 'info' },
  picking_in_progress: { label: 'Picking', tone: 'attention' },
  picked: { label: 'Picked up', tone: 'success' },
  in_transit_to_warehouse: { label: 'In transit', tone: 'info' },
  arrived_at_warehouse: { label: 'At warehouse', tone: 'info' },
  sorting_in_progress: { label: 'Sorting', tone: 'attention' },
  sorted: { label: 'Sorted', tone: 'success' },
  ready_for_dispatch: { label: 'Ready for dispatch', tone: 'success' },
  delivery_assigned: { label: 'Delivery assigned', tone: 'info' },
  dispatched: { label: 'Dispatched', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  exception_missing_bag: { label: 'Missing bag', tone: 'danger' },
  exception_partial_sort: { label: 'Partial sort', tone: 'danger' },
};

export function orderStatusMeta(status: string): StatusMeta {
  return (
    ORDER_STATUS_META[status as OrderStatus] ?? {
      label: status.replace(/_/g, ' '),
      tone: 'neutral',
    }
  );
}

const HOLE_STATUS_META: Record<PigeonHoleStatus, StatusMeta> = {
  free: { label: 'Free', tone: 'success' },
  reserved: { label: 'Reserved', tone: 'info' },
  partially_filled: { label: 'Filling', tone: 'attention' },
  filled: { label: 'Filled', tone: 'neutral' },
  out_of_service: { label: 'Out of service', tone: 'danger' },
};

export function holeStatusMeta(status: string): StatusMeta {
  return (
    HOLE_STATUS_META[status as PigeonHoleStatus] ?? {
      label: status.replace(/_/g, ' '),
      tone: 'neutral',
    }
  );
}

const PICKER_STATUS_META: Record<UserStatus, StatusMeta> = {
  active: { label: 'Active', tone: 'success' },
  suspended: { label: 'Suspended', tone: 'attention' },
  offboarded: { label: 'Offboarded', tone: 'danger' },
};

export function pickerStatusMeta(status: string): StatusMeta {
  return (
    PICKER_STATUS_META[status as UserStatus] ?? {
      label: status.replace(/_/g, ' '),
      tone: 'neutral',
    }
  );
}
