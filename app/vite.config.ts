import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Auto-update the service worker on every deploy so an open PWA tab
      // never runs stale scanning logic against a newer database schema
      // (docs/TECHNICAL_DESIGN_DOCUMENT.md Section 7.0 versioning note).
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Picker & Sort Wall',
        short_name: 'Picker/Sort Wall',
        description: 'Picker and Sort Wall operations app',
        theme_color: '#111827',
        background_color: '#111827',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell for offline start-up; API/data calls always go
        // to Supabase directly and are handled by the IndexedDB queue
        // (Section 10.2), not by service-worker caching, since scan
        // correctness must never depend on a cached network response.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
