import type { DeliveryMode } from '../types/database';

// Where a scan happened, so a raw server error can be turned into a message
// that tells the picker exactly what to do next.
export type ScanContext =
  | 'pickup' // scanning bags at the store
  | 'gate' // scanning the warehouse gate
  | 'verify-hole' // pre-assigned: scanning the assigned hole
  | 'sort-bag' // pre-assigned: scanning a bag into the assigned hole
  | 'claim-hole' // picker-chosen: scanning any free hole to hold it
  | 'chosen-bag'; // picker-chosen: scanning a bag into the chosen hole

export function wallLabel(mode?: DeliveryMode | null): string {
  if (mode === 'LMS') return 'LMS wall';
  if (mode === 'Hyperlocal') return 'Hyperlocal wall';
  return 'correct wall';
}

/**
 * Turns a raw server/RPC error into a short, human-friendly instruction. The
 * mapping keys off stable phrases in the server messages plus the scan context
 * (whether the picker was scanning a hole, a bag, or the gate), so the picker
 * always knows what went wrong and what to scan next.
 *
 * Every branch returns an imperative next step ("Please scan ..."), never a
 * bare diagnosis, because the reader is a picker on the floor mid-flow.
 */
export function friendlyScanError(
  ctx: ScanContext,
  raw: string | undefined | null,
  deliveryMode?: DeliveryMode | null,
): string {
  const m = (raw ?? '').toLowerCase();
  const expectingHole = ctx === 'verify-hole' || ctx === 'claim-hole';
  const expectingBag = ctx === 'pickup' || ctx === 'sort-bag' || ctx === 'chosen-bag';

  // --- Warehouse gate -----------------------------------------------------
  // The gate step scans one specific QR; anything else (a bag, a hole, an old
  // gate code) should point the picker back to the entrance QR.
  if (ctx === 'gate' || m.includes('gate qr') || m.includes('gate code')) {
    if (m.includes('no active sort wall') || m.includes('warehouse not found')) {
      return 'The warehouse is not set up for sorting yet. Please tell your supervisor.';
    }
    if (m.includes('not assigned') || m.includes('not found')) {
      return 'These orders are no longer yours to drop off. Please go back and refresh.';
    }
    return 'That is not the warehouse gate QR (or it has expired). Please scan the gate QR at the entrance.';
  }

  // --- Wrong wall (delivery-mode mismatch) --------------------------------
  // Name the wall the ORDER belongs to so the picker walks to the right place
  // (an LMS order rejected at a Hyperlocal hole -> "go to the LMS wall"). The
  // server message is "This hole is on the X wall. Use a Y hole ..." where Y is
  // the order's mode, so prefer that; fall back to the passed delivery mode.
  if (m.includes('wall')) {
    let target = wallLabel(deliveryMode);
    if (m.includes('use a lms hole')) target = 'LMS wall';
    else if (m.includes('use a hyperlocal hole')) target = 'Hyperlocal wall';
    return `Wrong wall - please go to the ${target}.`;
  }

  // --- Wrong hole for a pre-assigned / sequenced order --------------------
  // Server sequences holes; scanning a later hole before finishing the current
  // one, or a hole that isn't the unlocked one, raises "Wrong pigeon hole ...".
  if (m.includes('wrong pigeon hole') || m.includes('unlocked hole') || m.includes('currently unlocked')) {
    return 'Wrong hole - please scan the highlighted hole for this order first.';
  }

  // --- Hole occupied / reserved / unavailable -----------------------------
  if (m.includes('holding another shipment') || m.includes('already holds') || m.includes('holds another')) {
    return 'This hole already has another order in it. Please scan an empty hole.';
  }
  if (m.includes('held by another picker')) {
    return 'Another picker is using this hole. Please scan a different empty hole.';
  }
  if (m.includes('out of service')) {
    return 'This hole is out of service. Please scan a different hole.';
  }
  if (m.includes('not free') || m.includes('not available') || m.includes('occupied') || m.includes('reserved')) {
    return 'This hole is occupied or reserved. Please scan another empty hole.';
  }
  if (m.includes('already being placed in another hole')) {
    return 'This order is already going into another hole. Please finish that hole first.';
  }

  // --- Wrong bag / wrong order --------------------------------------------
  if (
    m.includes('does not belong') ||
    m.includes("doesn't belong") ||
    m.includes('wrong bag') ||
    m.includes('bag belongs')
  ) {
    return 'Wrong bag - this bag does not belong to this order. Please scan the correct bag.';
  }

  // --- QR type / recognition, tailored to what we expected ----------------
  if (
    m.includes('recognized pigeon hole') ||
    m.includes('recognised pigeon hole') ||
    m.includes('recognized as a pigeon hole') ||
    m.includes('pigeon hole not found')
  ) {
    return expectingBag
      ? "That's a pigeon-hole QR, not a bag. Please scan a bag for this order."
      : "That is not a valid pigeon-hole QR. Please scan a pigeon hole.";
  }
  if (m.includes('not recognized') || m.includes('not recognised') || m.includes('inactive')) {
    return expectingHole
      ? "That QR wasn't recognised. Please scan a pigeon-hole QR."
      : "That QR wasn't recognised. Please scan the bag QR for this order.";
  }

  // --- Flow / state -------------------------------------------------------
  if (m.includes('not ready to be sorted') || m.includes('not in a pickable state') || m.includes('not assigned and ready')) {
    return 'This order is not ready for this step yet. Please go back and try again.';
  }
  if (
    m.includes('no remaining') ||
    m.includes('expected bag count already') ||
    m.includes('no remaining bags') ||
    m.includes('already complete') ||
    m.includes('already reached')
  ) {
    return expectingHole
      ? 'This order has already been placed. Nothing left to scan here.'
      : 'All bags for this order are already scanned.';
  }
  if (m.includes('not assigned to caller') || m.includes('not assigned')) {
    return 'This order is not assigned to you.';
  }

  // Fallback: show the raw message if we have one, otherwise a safe default.
  return raw && raw.trim() ? raw : 'Something went wrong. Please scan again.';
}
