// Vite config for tools/audio-render.mjs: same as the project config but without HMR / file watching,
// so concurrent edits by other workstreams don't reload the measurement page mid-run.
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  root,
  server: { port: Number(process.env.PORT ?? 5188), strictPort: true, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
