import { supabase } from './supabaseClient';

export type ActionType =
  | 'accept_order'
  | 'scan_bag_pickup'
  | 'scan_bag_for_sort'
  | 'scan_pigeon_hole'
  | 'scan_bag_into_pigeon_hole'
  | 'record_warehouse_arrival';

export interface ActionResult {
  localId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Direct, online-only RPC submission used by Picker mutations.
 *
 * Offline queueing, periodic drains, and IndexedDB retries intentionally do
 * not exist anymore: the mall has Wi-Fi and showing stale operational state is
 * riskier than clearly surfacing a connection failure. Scan RPCs still receive
 * a fresh client event id, so server-side idempotency continues to protect
 * against duplicate camera callbacks and browser retries.
 *
 * `buildPayload` receives a freshly generated client event id so callers can
 * include it as `p_client_event_id` for the scan/arrival RPCs that require it
 * for server-side idempotency.
 */
export async function submitAction(
  type: ActionType,
  buildPayload: (clientEventId: string) => Record<string, unknown>,
): Promise<ActionResult> {
  const localId = crypto.randomUUID();
  const { data, error } = await supabase.rpc(rpcNameFor(type), buildPayload(localId));
  if (error) return { localId, ok: false, error: error.message };
  return { localId, ok: true, data };
}

function rpcNameFor(type: ActionType): string {
  switch (type) {
    case 'accept_order':
      return 'accept_order_v1';
    case 'scan_bag_pickup':
      return 'scan_bag_pickup_v1';
    case 'scan_bag_for_sort':
      return 'scan_bag_for_sort_v1';
    case 'scan_pigeon_hole':
      return 'scan_pigeon_hole_v1';
    case 'scan_bag_into_pigeon_hole':
      return 'scan_bag_into_pigeon_hole_v1';
    case 'record_warehouse_arrival':
      return 'record_warehouse_arrival_v1';
  }
}
