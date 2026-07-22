import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// This release intentionally retires offline/PWA operation. A previously
// installed version may still have Workbox's service worker registered, so
// explicitly remove it once rather than allowing a stale scanner bundle to
// survive a deploy from cache.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => void registration.unregister());
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
