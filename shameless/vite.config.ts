import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true, host: '127.0.0.1' },
  preview: { port: Number(process.env.PORT ?? 4173), strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
