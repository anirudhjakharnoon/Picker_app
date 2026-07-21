import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';

export function LoginPage() {
  const { signInWithPassword, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setLocalError(null);
    const { error: signInError } = await signInWithPassword(email.trim(), password);
    setSubmitting(false);
    if (signInError) setLocalError(signInError);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Sort Wall &amp; Picker</h1>
        <p className="auth-subtitle">Sign in with the email and password an admin created for you.</p>
        <form onSubmit={handleSubmit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
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
          No self-signup: accounts are created by an Admin. If you can&apos;t sign in, ask your Ops
          Manager to reset your password.
        </p>
      </div>
    </div>
  );
}
