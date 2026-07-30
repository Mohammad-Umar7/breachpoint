import fs from 'node:fs';
import path from 'node:path';
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
/**
 * Substitute __SITE_URL__ in index.html at build time.
 *
 * Open Graph and canonical tags need ABSOLUTE urls — crawlers and link
 * unfurlers do not reliably resolve relative og:image paths — but the deployed
 * hostname is not known until the site exists. So it comes from the
 * environment:
 *
 *   VITE_SITE_URL=https://breachpoint.pages.dev npm run build
 *
 * Left unset, the placeholder collapses to an empty string, which yields
 * relative urls. Those are harmless locally; they just mean shared links will
 * not show a preview image until the variable is set.
 */
function htmlSiteUrl() {
  const site = () => (process.env.VITE_SITE_URL || '').replace(/\/+$/, '');
  return {
    name: 'html-site-url',
    transformIndexHtml(html) {
      return html.replaceAll('__SITE_URL__', site());
    },
    /**
     * robots.txt and sitemap.xml live in public/, which Vite copies verbatim —
     * transformIndexHtml never sees them. Patch the emitted copies instead, so
     * all three files carry the same URL and cannot drift.
     */
    writeBundle(options) {
      const outDir = options.dir || 'dist';
      for (const name of ['robots.txt', 'sitemap.xml']) {
        const file = path.join(outDir, name);
        if (!fs.existsSync(file)) continue;
        const patched = fs.readFileSync(file, 'utf8').replaceAll('__SITE_URL__', site());
        fs.writeFileSync(file, patched, 'utf8');
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [htmlSiteUrl()],
  server: {
    port: 5173,
    // Listen on every interface, not just localhost, so someone else on the
    // same Wi-Fi can open the game. Without this Vite binds 127.0.0.1 and a
    // second machine cannot reach it at all.
    host: true,
    // Set to true if you want the dev server to launch your browser for you.
    open: false,
  },
  build: {
    target: 'es2022',
    // Off for production. The map was 5.3 MB — bigger than the bundle itself,
    // half the total deploy, and it publishes the full readable source to
    // anyone with the URL, which rather undoes keeping the repo private.
    //
    // Need it to debug a live issue? Build with:
    //   SOURCEMAP=true npm run build
    sourcemap: process.env.SOURCEMAP === 'true',
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    include: ['three', '@dimforge/rapier3d-compat'],
  },
});
