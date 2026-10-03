import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    // Trailing slash matters: a bare '/api' prefix also matches the UI's own
    // /api.ts module and proxies it to the server (404).
    proxy: { '/api/': 'http://127.0.0.1:7878' },
  },
});
