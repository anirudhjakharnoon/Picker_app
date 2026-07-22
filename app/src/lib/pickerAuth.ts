/** Normalise a picker mobile the same way as admin_normalise_picker_phone_v1. */
export function normalisePickerPhone(mobile: string): string | null {
  let raw = mobile.trim().replace(/[^\d+]/g, '');
  if (!raw) return null;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;

  let digits = raw.replace(/\D/g, '');
  if (/^00[1-9]\d{7,14}$/.test(digits)) digits = digits.slice(2);

  // UAE local 05XXXXXXXX / 5XXXXXXXX -> +9715XXXXXXXX.
  if (/^0?5\d{8}$/.test(digits)) {
    return `+971${digits.replace(/^0/, '')}`;
  }

  // Country code without +, or any 8–15 digit international number.
  if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

/** Build the synthetic Auth email used for picker mobile + login-code sign-in. */
export function toPickerAuthEmail(mobile: string): string {
  const phone = normalisePickerPhone(mobile);
  const digits = (phone ?? mobile).replace(/\D/g, '');
  return `p${digits}@picker.internal`;
}

export function validatePickerCreateInput(input: {
  fullName: string;
  phone: string;
  loginCode: string;
  zone: string;
  allZones: boolean;
}): string | null {
  const name = input.fullName.trim();
  if (name.length < 2) return 'Enter the picker’s full name (at least 2 characters).';

  if (!input.phone.trim()) return 'Enter a mobile number.';
  if (!normalisePickerPhone(input.phone)) {
    return `Mobile number “${input.phone.trim()}” is not recognised. Use a UAE number like 0501234567, or an international number like +971501234567.`;
  }

  const code = input.loginCode.trim();
  if (!code) return 'Enter a login code (6 to 8 digits).';
  if (!/^\d{6,8}$/.test(code)) {
    return `Login code must be 6 to 8 digits only (no letters or spaces). You entered “${code}”.`;
  }

  if (!input.allZones && !input.zone.trim()) {
    return 'Choose a zone (for example C), or tick All Zones.';
  }

  return null;
}

/** Map PostgREST / RPC failures to short operator-facing copy. */
export function humanizePickerCreateError(message: string): string {
  const text = message.trim();
  if (!text) return 'Something went wrong while creating the picker. Try again.';

  if (/could not find the function|admin_create_picker_v1/i.test(text)) {
    return 'Picker create is not installed yet. Run migration 0012_picker_create_clear_errors.sql (or 0011 then 0012) in the Supabase SQL editor, then try again.';
  }
  if (/permission denied|not permitted|only an admin/i.test(text)) {
    return 'Only an admin can create pickers. Sign in with an admin account.';
  }
  if (/JWT|not authenticated|401/i.test(text)) {
    return 'Your session expired. Sign in again, then create the picker.';
  }

  // Prefer the Postgres exception text when it is already written for humans.
  const withoutCode = text
    .replace(/^[A-Z0-9]{5}:\s*/i, '')
    .replace(/^ERROR:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return withoutCode || text;
}
