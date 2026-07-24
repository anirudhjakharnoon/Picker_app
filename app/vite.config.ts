import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  // The app is installable as a standalone PWA (public/manifest.webmanifest +
  // public/sw.js). Operations must reflect server truth immediately, so the
  // service worker is deliberately NETWORK-FIRST: it exists to make the app
  // installable and to provide an offline shell fallback, never to serve a
  // stale scanner or operations screen while the device is online.
  plugins: [react()],
});
