import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web build (default): base '/' — the SPA is served from the domain root
// (Railway), and deep routes like /order/success need absolute asset URLs;
// with './' the browser would resolve assets relative to the route path
// (/order/assets/...) and 404, blanking the page.
//
// Desktop build (SIAMSHOP-ELECTRON-001): ELECTRON_BUILD=1 → base './' so the
// bundle loads from file:// inside Electron (which uses the hash router, so
// deep paths are not an issue there), output to client/dist-electron so the
// web dist is untouched. Run via `npm run build:electron-client` at the root.
const electron = process.env.ELECTRON_BUILD === '1';

export default defineConfig({
  plugins: [react()],
  base: electron ? './' : '/',
  build: {
    outDir: electron ? 'dist-electron' : 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Proxy /api to the local backend during dev so api.js can use relative URLs.
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
});
