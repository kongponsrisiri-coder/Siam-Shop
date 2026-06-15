import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '/' (absolute asset paths): the SPA is served from the domain root
// (Railway/Netlify), and deep routes like /order/success need absolute asset
// URLs — with './' the browser would resolve assets relative to the route path
// (/order/assets/...) and 404, blanking the page.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    // Proxy /api to the local backend during dev so api.js can use relative URLs.
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
});
