import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Register the network-first service worker so the app is installable as a
// standalone home-screen app (see public/sw.js). It is network-first, so it
// never serves a stale operational screen while online; it only provides an
// offline shell fallback. Registered in production only - in dev it would
// interfere with Vite HMR - and after load so it never competes with the
// first paint or the camera coming up.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed SW registration must never break the app; installability is
      // an enhancement, not a requirement for the app to run.
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
