import { describe, expect, it } from 'vitest';
import { toPickerAuthEmail } from './pickerAuth';

describe('toPickerAuthEmail', () => {
  it('normalises UAE local mobiles to the synthetic auth email', () => {
    expect(toPickerAuthEmail('0501234567')).toBe('p971501234567@picker.internal');
    expect(toPickerAuthEmail('501234567')).toBe('p971501234567@picker.internal');
  });

  it('keeps explicit E.164 digits', () => {
    expect(toPickerAuthEmail('+971501234567')).toBe('p971501234567@picker.internal');
  });
});
