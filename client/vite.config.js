import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the built dist works whether served from Netlify root or from
// the Express static fallback. (CLAUDE.md rule: always base './')
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    // Proxy /api to the local backend during dev so api.js can use relative URLs.
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
});
