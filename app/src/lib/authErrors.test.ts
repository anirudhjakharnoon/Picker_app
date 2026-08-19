import { describe, expect, it } from 'vitest';
import { humanizeAuthError, isRetryableAuthError } from './authErrors';

describe('isRetryableAuthError', () => {
  it('flags Supabase/PostgREST schema-cache hiccups as retryable', () => {
    expect(isRetryableAuthError('Could not query the database for the schema cache. Retrying.')).toBe(true);
    expect(isRetryableAuthError('PGRST002')).toBe(true);
  });

  it('flags generic network failures as retryable', () => {
    expect(isRetryableAuthError('Failed to fetch')).toBe(true);
    expect(isRetryableAuthError('Request timed out')).toBe(true);
  });

  it('does not flag credential errors as retryable', () => {
    expect(isRetryableAuthError('Invalid login credentials')).toBe(false);
  });
});

describe('humanizeAuthError', () => {
  it('explains the schema-cache error in plain language', () => {
    const message = humanizeAuthError('Could not query the database for the schema cache. Retrying.');
    expect(message).toMatch(/temporarily unavailable/i);
    expect(message).toMatch(/retry/i);
  });

  it('passes through unrelated messages unchanged', () => {
    expect(humanizeAuthError('Invalid login credentials')).toBe('Invalid login credentials');
  });

  it('falls back to a generic message for empty input', () => {
    expect(humanizeAuthError('   ')).toMatch(/something went wrong/i);
  });
});
