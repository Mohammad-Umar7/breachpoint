import { defineConfig } from 'vite';

/**
 * Vite configuration.
 *
 * `@dimforge/rapier3d-compat` ships its WebAssembly payload as an inlined
 * base64 string, so no special WASM plugin or asset copying is required —
 * it just needs to be excluded from dependency pre-bundling optimisation
 * on some setups. We keep it in `optimizeDeps.include` because the compat
 * build is plain ESM and pre-bundling speeds up cold starts noticeably.
 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    // Set to true if you want the dev server to launch your browser for you.
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    include: ['three', '@dimforge/rapier3d-compat'],
  },
});
