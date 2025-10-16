import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const rootDir = dirname(fileURLToPath(import.meta.url));
const fromRoot = (...paths) => resolve(rootDir, ...paths);

export default defineConfig({
  base: '/assets/',
  appType: 'mpa',
  plugins: [],
  build: {
    outDir: 'build/vite',
    emptyOutDir: false,
    manifest: true,
    rollupOptions: {
      input: {
        lib: fromRoot('frontend/entries/lib.js'),
        editor: fromRoot('frontend/entries/editor.js'),
        review: fromRoot('frontend/entries/review.js'),
        register: fromRoot('frontend/entries/register.js'),
        upload: fromRoot('frontend/entries/upload.js'),
        user: fromRoot('frontend/entries/user.js'),
        'manage-urls': fromRoot('frontend/entries/manage-urls.js'),
        'upload-modal': fromRoot('frontend/entries/upload-modal.js'),
        apitest: fromRoot('frontend/entries/apitest.js')
      },
      output: {
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  resolve: {
    alias: {
      // Mirror browserify's ability to resolve modules relative to project root.
      '@frontend': fromRoot('frontend')
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV)
  }
});
