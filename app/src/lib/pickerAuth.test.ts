import { describe, expect, it } from 'vitest';
import {
  humanizePickerCreateError,
  normalisePickerPhone,
  toPickerAuthEmail,
  validatePickerCreateInput,
} from './pickerAuth';

describe('normalisePickerPhone', () => {
  it('accepts UAE local and international forms', () => {
    expect(normalisePickerPhone('0501234567')).toBe('+971501234567');
    expect(normalisePickerPhone('501234567')).toBe('+971501234567');
    expect(normalisePickerPhone('+971501234567')).toBe('+971501234567');
    expect(normalisePickerPhone('971501234567')).toBe('+971501234567');
    expect(normalisePickerPhone('00971501234567')).toBe('+971501234567');
  });

  it('rejects unusable values', () => {
    expect(normalisePickerPhone('')).toBeNull();
    expect(normalisePickerPhone('123')).toBeNull();
    expect(normalisePickerPhone('abc')).toBeNull();
  });
});

describe('toPickerAuthEmail', () => {
  it('normalises UAE local mobiles to the synthetic auth email', () => {
    expect(toPickerAuthEmail('0501234567')).toBe('p971501234567@picker.internal');
    expect(toPickerAuthEmail('971501234567')).toBe('p971501234567@picker.internal');
  });
});

describe('validatePickerCreateInput', () => {
  it('returns specific field errors', () => {
    expect(validatePickerCreateInput({
      fullName: 'A', phone: '0501234567', loginCode: '123456', zone: 'C', allZones: false,
    })).toMatch(/full name/i);

    expect(validatePickerCreateInput({
      fullName: 'Ali', phone: '12', loginCode: '123456', zone: 'C', allZones: false,
    })).toMatch(/not recognised/i);

    expect(validatePickerCreateInput({
      fullName: 'Ali', phone: '0501234567', loginCode: '12ab', zone: 'C', allZones: false,
    })).toMatch(/6 to 8 digits/i);

    expect(validatePickerCreateInput({
      fullName: 'Ali', phone: '0501234567', loginCode: '123456', zone: '', allZones: false,
    })).toMatch(/Choose a zone/i);

    expect(validatePickerCreateInput({
      fullName: 'Ali', phone: '0501234567', loginCode: '123456', zone: '', allZones: true,
    })).toBeNull();
  });
});

describe('humanizePickerCreateError', () => {
  it('keeps human SQL messages and clarifies install/auth failures', () => {
    expect(humanizePickerCreateError('Enter a mobile number.')).toBe('Enter a mobile number.');
    expect(humanizePickerCreateError('Could not find the function public.admin_create_picker_v1')).toMatch(/not installed/i);
    expect(humanizePickerCreateError('Only an admin can create pickers.')).toMatch(/admin/i);
  });
});
