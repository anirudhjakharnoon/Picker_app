// Hand-written types mirroring supabase/migrations/0001_schema.sql.
//
// These are NOT auto-generated because this environment has no Supabase CLI
// access token to run `supabase gen types typescript`. Once you have the CLI
// linked to the project, regenerate with:
//   supabase gen types typescript --project-id aetrwtubfifljkxwocpy > src/types/database.ts
// and this file can be replaced wholesale.

export type UserRole = 'picker' | 'warehouse_staff' | 'ops_manager' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'offboarded';

export type OrderStatus =
  | 'ingested'
  | 'available'
  | 'assigned'
  | 'picking_in_progress'
  | 'picked'
  | 'in_transit_to_warehouse'
  | 'arrived_at_warehouse'
  | 'sorting_in_progress'
  | 'sorted'
  | 'ready_for_dispatch'
  | 'delivery_assigned'
  | 'dispatched'
  | 'completed'
  | 'cancelled'
  | 'exception_missing_bag'
  | 'exception_partial_sort';

export type OrderBagStatus = 'expected' | 'picked_up' | 'sorted' | 'dispatched' | 'missing' | 'lost';

export type PigeonHoleStatus = 'free' | 'reserved' | 'partially_filled' | 'filled' | 'out_of_service';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  status: UserStatus;
  warehouse_id: string | null;
  is_online: boolean;
  current_lat: number | null;
  current_lng: number | null;
  home_zone: string | null;
  phone_e164?: string | null;
  picker_code?: string | null;
  all_zones?: boolean;
  max_concurrent_orders: number;
  is_super_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  store_id: string;
  external_order_ref: string;
  bag_count_expected: number;
  bag_count_scanned_pickup: number;
  bag_count_scanned_sort: number;
  store_floor: string | null;
  store_zone: string | null;
  store_address: string | null;
  qr_mode: 'shared_order' | 'unique_bag';
  shared_bag_qr_code_id: string | null;
  status: OrderStatus;
  // Optional: only present once migration 0005 has been applied. The UI reads
  // it defensively so the app works with or without that migration.
  is_fragile?: boolean;
  assigned_picker_id: string | null;
  warehouse_id: string | null;
  sort_wall_id: string | null;
  pigeon_hole_id: string | null;
  priority: number;
  ingested_at: string;
  assigned_at: string | null;
  picked_at: string | null;
  warehouse_arrived_at: string | null;
  sorted_at: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderBag {
  id: string;
  order_id: string;
  bag_sequence: number;
  status: OrderBagStatus;
  qr_code_id: string | null;
  picked_up_at: string | null;
  sorted_at: string | null;
  dispatched_at: string | null;
}

export interface Warehouse {
  id: string;
  name: string;
  address: string | null;
  status: 'active' | 'inactive';
  gate_qr_rotation_minutes?: number;
}

export interface SortWall {
  id: string;
  warehouse_id: string;
  name: string;
  rows: number;
  columns: number;
  status: 'active' | 'inactive';
}

export interface PigeonHole {
  id: string;
  sort_wall_id: string;
  hole_number: string;
  qr_code_id: string | null;
  status: PigeonHoleStatus;
  priority_reserved: boolean;
  bag_capacity?: number;
  created_at: string;
  updated_at: string;
}

export interface QrCode {
  id: string;
  code_type: 'bag' | 'pigeon_hole' | 'warehouse_gate';
  code_value: string;
  code_version: number;
  entity_id: string | null;
  status: 'active' | 'revoked' | 'expired';
  expires_at: string | null;
  created_at: string;
}

export interface OperationsConfiguration {
  singleton: boolean;
  max_orders_per_picker: number;
  bags_per_pigeon_hole: number;
  updated_at: string;
  updated_by_user_id: string | null;
  auto_assign_enabled?: boolean;
  assignment_policy?: 'least_active_orders';
  null_zone_matches_all_pickers?: boolean;
}

export interface Notification {
  id: string;
  recipient_user_id: string;
  channel: 'in_app' | 'web_push';
  template: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
  read_at: string | null;
}

export interface StatusHistoryRow {
  id: string;
  entity_type: string;
  entity_id: string;
  from_status: string | null;
  to_status: string;
  actor_type: string;
  actor_user_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface BagScanRow {
  id: string;
  order_id: string;
  order_bag_id: string | null;
  scan_type: string;
  scanned_entity_type: string;
  actor_user_id: string;
  client_captured_at: string;
  created_at: string;
  is_valid: boolean;
  rejection_reason: string | null;
}

export interface Store {
  id: string;
  external_ref: string;
  name: string;
  default_zone: string | null;
  status: 'active' | 'paused' | 'offboarded';
}

// Minimal Database shape for supabase-js generics. We only type the tables
// this app actually queries directly (RPC return types are declared at each
// call site instead, since PostgREST cannot introspect them automatically).
export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      orders: { Row: Order; Insert: Partial<Order>; Update: Partial<Order> };
      order_bags: { Row: OrderBag; Insert: Partial<OrderBag>; Update: Partial<OrderBag> };
      warehouses: { Row: Warehouse; Insert: Partial<Warehouse>; Update: Partial<Warehouse> };
      sort_walls: { Row: SortWall; Insert: Partial<SortWall>; Update: Partial<SortWall> };
      pigeon_holes: { Row: PigeonHole; Insert: Partial<PigeonHole>; Update: Partial<PigeonHole> };
      qr_codes: { Row: QrCode; Insert: Partial<QrCode>; Update: Partial<QrCode> };
      operations_configuration: { Row: OperationsConfiguration; Insert: Partial<OperationsConfiguration>; Update: Partial<OperationsConfiguration> };
      notifications: { Row: Notification; Insert: Partial<Notification>; Update: Partial<Notification> };
      status_history: { Row: StatusHistoryRow; Insert: Partial<StatusHistoryRow>; Update: never };
      bag_scans: { Row: BagScanRow; Insert: Partial<BagScanRow>; Update: never };
      stores: { Row: Store; Insert: Partial<Store>; Update: Partial<Store> };
    };
  };
}
