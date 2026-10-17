import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from GitHub Pages at /staple/. Override with STAPLE_BASE for other hosts.
export default defineConfig({
  base: process.env.STAPLE_BASE ?? '/staple/',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
