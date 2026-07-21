import Dexie, { type Table } from 'dexie';

// Browser-native offline store for the Picker tab (docs/TECHNICAL_DESIGN_DOCUMENT.md
// Section 10.2: IndexedDB via Dexie, not native SQLite, because this is a PWA).
//
// Two concerns live here:
//   1. `pendingActions` — a durable outbound queue. Every scan/action is
//      written here immediately, before any network attempt, so scanning
//      keeps working with zero connectivity.
//   2. `cachedAssignments` — a local mirror of the picker's currently
//      assigned orders (including bag counts) so the scanner screen can
//      validate "does this code belong to this order" without a network
//      round trip.

export type PendingActionType =
  | 'accept_order'
  | 'decline_order'
  | 'set_picker_status'
  | 'scan_bag_pickup'
  | 'scan_bag_for_sort'
  | 'scan_pigeon_hole'
  | 'record_warehouse_arrival'
  | 'report_order_issue';

export interface PendingAction {
  id?: number;
  type: PendingActionType;
  clientEventId: string;
  payload: Record<string, unknown>;
  createdAt: string; // when the action happened on-device (client_captured_at)
  attempts: number;
  lastError?: string;
  status: 'pending' | 'syncing' | 'failed_permanent';
}

export interface CachedAssignment {
  orderId: string; // primary key
  externalOrderRef: string;
  storeName: string;
  storeFloor: string | null;
  storeZone: string | null;
  storeAddress: string | null;
  bagCountExpected: number;
  bagCountScannedPickup: number;
  bagCountScannedSort: number;
  status: string;
  sharedQrCodeValue: string | null;
  pigeonHoleNumber: string | null;
  updatedAt: string;
}

class OfflineDatabase extends Dexie {
  pendingActions!: Table<PendingAction, number>;
  cachedAssignments!: Table<CachedAssignment, string>;

  constructor() {
    super('picker_sortwall_offline');
    this.version(1).stores({
      pendingActions: '++id, status, createdAt',
      cachedAssignments: 'orderId, status',
    });
  }
}

export const offlineDb = new OfflineDatabase();

export async function enqueueAction(
  type: PendingActionType,
  payload: Record<string, unknown>,
  clientEventId: string,
  createdAt: string = new Date().toISOString()
): Promise<number> {
  return offlineDb.pendingActions.add({
    type,
    clientEventId,
    payload,
    createdAt,
    attempts: 0,
    status: 'pending',
  });
}

export function newClientEventId(): string {
  return crypto.randomUUID();
}
