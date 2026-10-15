import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  resolve: { preserveSymlinks: true },
  build: { outDir: '../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:8787' } },
});
