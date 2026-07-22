/** Build the synthetic Auth email used for picker mobile + login-code sign-in. */
export function toPickerAuthEmail(mobile: string): string {
  const raw = mobile.trim().replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(raw)) {
    return `p${raw.replace(/\D/g, '')}@picker.internal`;
  }
  const digits = raw.replace(/\D/g, '');
  // Match admin_normalise_picker_phone_v1 / Manpower create: UAE local → +971.
  if (/^0?5\d{8}$/.test(digits)) {
    return `p971${digits.replace(/^0/, '')}@picker.internal`;
  }
  return `p${digits}@picker.internal`;
}
