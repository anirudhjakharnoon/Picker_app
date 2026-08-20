import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Shown when Supabase Auth accepted the sign-in (there is a valid session) but
 * the `profiles` read that has to follow it keeps failing.
 *
 * This state is worth its own screen rather than falling back to LoginPage:
 * the credentials were correct and re-typing them cannot help, so showing the
 * sign-in form again is actively misleading — it reads as "wrong mobile number
 * or login code" when the real problem is that the project's REST API is
 * unreachable (503/521/522 from the API gateway when the database instance is
 * out of CPU/memory headroom, for example).
 */
export function BackendUnavailablePage() {
  const { error, retrying, autoRetryPaused, refreshProfile, signOut } = useAuth();
  const [manualRetrying, setManualRetrying] = useState(false);

  const handleRetry = async () => {
    setManualRetrying(true);
    await refreshProfile();
    setManualRetrying(false);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <span className="brand-wordmark auth-wordmark">
          Dubai Mall
          <span className="brand-wordmark-sub">Delivery ops · picker &amp; sort wall</span>
        </span>
        <h1 className="backend-down-heading">Signed in, but the server is not responding</h1>
        <p className="auth-subtitle">
          Your mobile number and login code were accepted — this is not a sign-in
          problem. The app could not load your account details from the server, so
          it cannot open your queue yet.
        </p>
        {error && <p className="error-text">{error}</p>}
        <p className="auth-subtitle">
          {retrying && !manualRetrying
            ? 'Still trying to reach the server…'
            : autoRetryPaused
              ? // Say plainly that nothing is happening in the background. Retrying
                // on a loop against a server that is down cannot fix it and only
                // adds load, so the next attempt is deliberately the picker's call.
                'Automatic retries have stopped so the server is not overloaded. Tap Try again when you are ready, and tell your administrator if it keeps happening.'
              : 'This usually clears on its own. Try again in a moment, and tell your administrator if it keeps happening.'}
        </p>
        <button type="button" onClick={() => void handleRetry()} disabled={manualRetrying}>
          {manualRetrying ? 'Trying again…' : 'Try again'}
        </button>
        <button type="button" className="link-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
