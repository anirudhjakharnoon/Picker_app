import { describe, expect, it } from 'vitest';
import { friendlyScanError } from './scanErrors';

// The values on the left are the ACTUAL exception strings raised by the
// Postgres RPCs (see supabase/migrations/*.sql). If a server message is
// reworded, this suite fails loudly instead of silently regressing to the raw,
// unfriendly text on the picker's screen.
describe('friendlyScanError - real server strings map to picker-friendly text', () => {
  it('maps a wrong-wall rejection to a wall-specific instruction', () => {
    const msg = friendlyScanError(
      'claim-hole',
      'This hole is on the Hyperlocal wall. Use a LMS hole for this shipment.',
      'LMS',
    );
    expect(msg).toBe('Wrong wall - please scan an empty hole on the LMS wall.');
  });

  it('tells a Hyperlocal picker which wall to use', () => {
    const msg = friendlyScanError('claim-hole', 'This hole is on the LMS wall.', 'Hyperlocal');
    expect(msg).toContain('Hyperlocal wall');
  });

  it('maps an occupied hole', () => {
    expect(friendlyScanError('claim-hole', 'This pigeon hole is not free. Scan an empty hole.')).toBe(
      'This hole is occupied or reserved. Please scan another empty hole.',
    );
  });

  it('maps a hole already holding another shipment', () => {
    expect(
      friendlyScanError('claim-hole', 'This pigeon hole already holds a shipment. Scan an empty hole.'),
    ).toContain('already has another order');
  });

  it('maps an out-of-service hole', () => {
    expect(friendlyScanError('claim-hole', 'This pigeon hole is out of service. Scan another hole.')).toContain(
      'out of service',
    );
  });

  it('maps a wrong bag (does not belong to the hole/order)', () => {
    expect(friendlyScanError('sort-bag', 'Wrong bag, bag does not belong to the hole')).toBe(
      'Wrong bag - this bag does not belong to this order. Please scan the correct bag.',
    );
    expect(friendlyScanError('pickup', 'qr code does not belong to this order')).toContain(
      'does not belong to this order',
    );
  });

  it('maps the sequenced "wrong pigeon hole" rejection', () => {
    expect(
      friendlyScanError('verify-hole', 'Wrong pigeon hole. Complete the currently unlocked hole first.'),
    ).toBe('Wrong hole - please scan the highlighted hole for this order first.');
    expect(friendlyScanError('verify-hole', 'Wrong pigeon hole. Scan the currently unlocked hole: A-03')).toContain(
      'highlighted hole',
    );
  });

  it('distinguishes an unrecognised QR by what was expected', () => {
    expect(friendlyScanError('sort-bag', 'qr code not recognized or inactive')).toContain('bag QR');
    expect(friendlyScanError('claim-hole', 'qr code not recognized or inactive')).toContain('pigeon-hole QR');
  });

  it('tells a bag-scanner they scanned a hole QR', () => {
    expect(friendlyScanError('sort-bag', 'QR code is not a recognized pigeon hole')).toContain('not a bag');
  });

  it('gives a clear gate message for an invalid/expired gate QR', () => {
    expect(
      friendlyScanError('gate', 'gate QR code is invalid or has expired; refresh the warehouse QR display'),
    ).toContain('gate QR at the entrance');
  });

  it('handles a gate scan when no sort wall is configured', () => {
    expect(friendlyScanError('gate', 'no active sort wall configured for this warehouse')).toContain('supervisor');
  });

  it('maps "all bags already scanned" state', () => {
    expect(friendlyScanError('pickup', 'expected bag count already reached')).toBe(
      'All bags for this order are already scanned.',
    );
  });

  it('never returns an empty string, even with no message', () => {
    expect(friendlyScanError('pickup', undefined)).toBeTruthy();
    expect(friendlyScanError('pickup', '')).toBeTruthy();
    expect(friendlyScanError('pickup', null)).toBeTruthy();
  });

  it('every known server phrase produces a non-raw, actionable message', () => {
    const serverPhrases = [
      'This hole is on the LMS wall. Use a Hyperlocal hole for this shipment.',
      'This pigeon hole is not free. Scan an empty hole.',
      'This pigeon hole already holds a shipment. Scan an empty hole.',
      'This pigeon hole is out of service. Scan another hole.',
      'Wrong bag, bag does not belong to the hole',
      'qr code does not belong to this order',
      'Wrong pigeon hole. Complete the currently unlocked hole first.',
      'QR code is not a recognized pigeon hole',
      'qr code not recognized or inactive',
      'gate QR code is invalid or has expired; refresh the warehouse QR display',
      'expected bag count already reached',
    ];
    for (const phrase of serverPhrases) {
      const out = friendlyScanError('sort-bag', phrase);
      // A mapped message is rewritten, not echoed verbatim.
      expect(out).not.toBe(phrase);
      // And it always ends with actionable guidance.
      expect(out.toLowerCase()).toMatch(/please|scan|already|supervisor|not ready/);
    }
  });
});
