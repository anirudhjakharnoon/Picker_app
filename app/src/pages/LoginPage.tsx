import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { toPickerAuthEmail } from '../lib/pickerAuth';

export function LoginPage() {
  const { signInWithPassword, error, session, profile, retrying, refreshProfile } = useAuth();
  const [mode, setMode] = useState<'picker' | 'staff'>('picker');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [manualRetrying, setManualRetrying] = useState(false);

  // A session can already exist (e.g. a previous sign-in) while the profile
  // fetch that follows it keeps failing on a transient backend error — that
  // shows this same screen (see AppShell in App.tsx) with `error` set, even
  // though the credentials below are irrelevant to fixing it.
  const isStuckOnProfileLoad = Boolean(session) && !profile;

  const handleRetry = async () => {
    setManualRetrying(true);
    await refreshProfile();
    setManualRetrying(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setLocalError(null);
    const identifier = mode === 'picker' ? toPickerAuthEmail(email) : email.trim();
    const { error: signInError } = await signInWithPassword(identifier, password);
    setSubmitting(false);
    if (signInError) setLocalError(signInError);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <span className="brand-wordmark auth-wordmark">
          Dubai Mall
          <span className="brand-wordmark-sub">Delivery ops · picker &amp; sort wall</span>
        </span>
        <p className="auth-subtitle">
          {mode === 'picker' ? 'Pickers sign in with the mobile number and login code issued in Manpower.' : 'Staff sign in with the email and password an admin created for you.'}
        </p>
        {isStuckOnProfileLoad && (localError === null) && (
          <div className="error-text" role="status">
            <p>{error}</p>
            {retrying && !manualRetrying && <p>Retrying automatically…</p>}
            <button type="button" onClick={() => void handleRetry()} disabled={manualRetrying}>
              {manualRetrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        <div className="login-mode-switch" role="tablist" aria-label="Sign-in type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'picker'}
            className={mode === 'picker' ? 'active' : ''}
            onClick={() => {
              setMode('picker');
              setPassword('');
              setLocalError(null);
            }}
          >
            Picker
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'staff'}
            className={mode === 'staff' ? 'active' : ''}
            onClick={() => {
              setMode('staff');
              setPassword('');
              setLocalError(null);
            }}
          >
            Staff
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <label>
            {mode === 'picker' ? 'Mobile number' : 'Email'}
            <input
              type={mode === 'picker' ? 'tel' : 'email'}
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            {mode === 'picker' ? 'Login code' : 'Password'}
            <input
              type="password"
              inputMode={mode === 'picker' ? 'numeric' : undefined}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {(localError || (error && !isStuckOnProfileLoad)) && (
            <p className="error-text">{localError ?? error}</p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="auth-footnote">
          No self-signup: picker access is managed from the Manpower panel.
        </p>
      </div>
    </div>
  );
}
