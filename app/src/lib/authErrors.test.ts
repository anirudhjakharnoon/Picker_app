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

  it('flags gateway/origin-down status codes as retryable', () => {
    // Observed in the API gateway logs while the REST API was down: 503 from
    // the gateway, then Cloudflare 521/522/525 as the origin fell over.
    for (const status of ['500', '502', '503', '504', '521', '522', '525']) {
      expect(isRetryableAuthError(`Request failed with status ${status}`)).toBe(true);
    }
  });

  it('does not treat unrelated numbers as gateway errors', () => {
    expect(isRetryableAuthError('Login code must be 6 to 8 digits')).toBe(false);
    expect(isRetryableAuthError('5030 is not a valid code')).toBe(false);
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

  it('explains gateway errors and bare fetch failures as server-side, not credential, problems', () => {
    expect(humanizeAuthError('Request failed with status 521')).toMatch(/not responding/i);
    expect(humanizeAuthError('Request failed with status 521')).toMatch(/not your login details/i);
    expect(humanizeAuthError('Failed to fetch')).toMatch(/not a problem with your login details/i);
  });

  it('falls back to a generic message for empty input', () => {
    expect(humanizeAuthError('   ')).toMatch(/something went wrong/i);
  });
});
