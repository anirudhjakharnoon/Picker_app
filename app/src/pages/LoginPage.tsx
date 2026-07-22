import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { toPickerAuthEmail } from '../lib/pickerAuth';

export function LoginPage() {
  const { signInWithPassword, error } = useAuth();
  const [mode, setMode] = useState<'picker' | 'staff'>('picker');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
        <h1>Sort Wall &amp; Picker</h1>
        <p className="auth-subtitle">
          {mode === 'picker' ? 'Pickers sign in with the mobile number and login code issued in Manpower.' : 'Staff sign in with the email and password an admin created for you.'}
        </p>
        <div className="login-mode-switch" role="tablist">
          <button type="button" className={mode === 'picker' ? 'active' : ''} onClick={() => setMode('picker')}>Picker</button>
          <button type="button" className={mode === 'staff' ? 'active' : ''} onClick={() => setMode('staff')}>Staff</button>
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
          {(localError || error) && <p className="error-text">{localError ?? error}</p>}
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
