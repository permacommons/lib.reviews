#!/usr/bin/env node
/**
 * Backend/CLI production build using esbuild.
 * - Bundles server entry and CLI tools into ESM output under build/server/
 * - Keeps all npm packages external (node_modules required on host)
 * - Avoids TypeScript's emit blockers around .ts import specifiers
 *
 * Usage: npm run build:backend
 */

import { build } from 'esbuild';
import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDir, '..');

// Read package.json to mark dependencies as external
const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const externalPkgs = Object.keys(pkg.dependencies ?? {});
const devExternalPkgs = Object.keys(pkg.devDependencies ?? {});

// Discover entry points for server and CLI
const entryPatterns = [
  'bin/**/*.ts',
  'maintenance/**/*.ts',
  'tools/**/*.ts'
];
const ignore = ['**/*.d.ts'];

const entryPoints = await fg(entryPatterns, {
  cwd: projectRoot,
  ignore,
  onlyFiles: true
});

if (entryPoints.length === 0) {
  console.error('[build-backend] No entry points found.');
  process.exit(1);
}

console.log(`[build-backend] Building ${entryPoints.length} entry point(s)...`);

try {
  await build({
    absWorkingDir: projectRoot,
    entryPoints,
    outdir: resolve(projectRoot, 'build/server'),
    outbase: '.',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    sourcemap: false,
    minify: false,
    treeShaking: true,
    legalComments: 'eof',
    entryNames: '[dir]/[name]',
    chunkNames: '[name]-[hash]',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.LIBREVIEWS_VITE_DEV_SERVER': '"off"',
      'process.env.VITE_USE_POLLING': '"0"'
    },
    // Treat all node builtins and npm packages as external; app code is bundled.
    external: ['node:*', ...externalPkgs, ...devExternalPkgs, 'vite', 'lightningcss'],
    logLevel: 'info'
  });

  console.log('[build-backend] Build completed. Output in build/server/');
  process.exit(0);
} catch (error) {
  console.error('[build-backend] Build failed:', error);
  process.exit(1);
}