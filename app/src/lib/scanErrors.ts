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

function wallLabel(mode?: DeliveryMode | null): string {
  if (mode === 'LMS') return 'LMS wall';
  if (mode === 'Hyperlocal') return 'Hyperlocal wall';
  return 'correct wall';
}

/**
 * Turns a raw server/RPC error into a short, human-friendly instruction. The
 * mapping keys off stable phrases in the server messages plus the scan context
 * (whether the picker was scanning a hole or a bag), so the picker always knows
 * what went wrong and what to scan next.
 */
export function friendlyScanError(
  ctx: ScanContext,
  raw: string | undefined | null,
  deliveryMode?: DeliveryMode | null,
): string {
  const m = (raw ?? '').toLowerCase();
  const expectingHole = ctx === 'verify-hole' || ctx === 'claim-hole';
  const expectingBag = ctx === 'pickup' || ctx === 'sort-bag' || ctx === 'chosen-bag';

  // Wrong wall (delivery mode mismatch).
  if (m.includes('wall')) {
    return `Wrong wall - please scan an empty hole on the ${wallLabel(deliveryMode)}.`;
  }

  // Hole occupied / reserved / unavailable.
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

  // Wrong bag / wrong order.
  if (
    m.includes('does not belong') ||
    m.includes("doesn't belong") ||
    m.includes('wrong bag') ||
    m.includes('bag belongs')
  ) {
    return 'Wrong order! This bag does not belong to your assigned order. Please scan the correct bag.';
  }

  // QR type / recognition, tailored to what we expected.
  if (m.includes('recognized pigeon hole') || m.includes('recognized as a pigeon hole') || m.includes('pigeon hole not found')) {
    return expectingBag
      ? "That's a pigeon-hole QR, not a bag. Please scan a bag."
      : "That doesn't look like a pigeon-hole QR. Please scan a pigeon hole.";
  }
  if (m.includes('gate qr') || m.includes('gate code')) {
    return 'That is not the warehouse gate QR, or it has expired. Please scan the current gate QR.';
  }
  if (m.includes('not recognized') || m.includes('not recognised')) {
    return expectingHole
      ? "That QR wasn't recognized. Please scan a pigeon-hole QR."
      : "That QR wasn't recognized. Please scan the order's bag QR.";
  }

  // Flow/state.
  if (m.includes('not ready to be sorted') || m.includes('not in a pickable state')) {
    return 'This order is not ready for this step yet.';
  }
  if (m.includes('no remaining') || m.includes('expected bag count already') || m.includes('no remaining bags')) {
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
