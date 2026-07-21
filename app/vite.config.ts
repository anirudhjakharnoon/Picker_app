import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  // The mall has reliable Wi‑Fi and operations must reflect server truth
  // immediately, so this app is deliberately online-only. In particular,
  // there is no service-worker app-shell cache that can keep an out-of-date
  // scanner or operations screen running after a deployment.
  plugins: [react()],
});
