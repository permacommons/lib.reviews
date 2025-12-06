import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import rawEntries from './config/frontend-entries.json' with { type: 'json' };

const entries = rawEntries as Record<string, string>;
const rootDir = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...paths: string[]): string => resolve(rootDir, ...paths);

export default defineConfig({
  base: '/assets/',
  appType: 'mpa',
  plugins: [],
  server: {
    allowedHosts: ['dev.test'],
    // Avoid cache/revalidation timing issues in development (FOUCs observed when
    // browser cache is enabled).
    headers: {
      'Cache-Control': 'no-store',
    },
  },
  build: {
    outDir: 'build/frontend',
    emptyOutDir: false,
    manifest: true,
    rollupOptions: {
      input: Object.fromEntries(
        Object.entries(entries).map(([entryName, sourcePath]) => [entryName, fromRoot(sourcePath)])
      ),
      output: {
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: assetInfo =>
          extname(assetInfo.name ?? '') === '.css'
            ? 'css/[name]-[hash][extname]'
            : '[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      // Mirror browserify's ability to resolve modules relative to project root.
      '@frontend': fromRoot('frontend'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  },
});
