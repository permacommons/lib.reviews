'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const VITE_MANIFEST_PATH = path.join(PROJECT_ROOT, 'build', 'vite', '.vite', 'manifest.json');
const DEV_ENTRY_PREFIX = '/frontend/entries/';
const DEV_CLIENT_ENTRY = '/@vite/client';
const PUBLIC_ASSET_PREFIX = '/assets/';

const ENTRY_MAP = new Map(Object.entries({
  lib: 'frontend/entries/lib.js',
  editor: 'frontend/entries/editor.js',
  review: 'frontend/entries/review.js',
  register: 'frontend/entries/register.js',
  upload: 'frontend/entries/upload.js',
  user: 'frontend/entries/user.js',
  'manage-urls': 'frontend/entries/manage-urls.js',
  'upload-modal': 'frontend/entries/upload-modal.js',
  apitest: 'frontend/entries/apitest.js'
}));

let cachedManifest = null;

function shouldUseProdBuild() {
  return process.env.NODE_ENV === 'production' || process.env.LIBREVIEWS_VITE_DEV_SERVER === 'off';
}

function normalizeEntryName(value) {
  if (!value || typeof value !== 'string')
    return null;

  let normalized = value.trim();

  normalized = normalized.replace(/^frontend\/entries\//, '');
  normalized = normalized.replace(/\.m?js$/, '');
  normalized = normalized.replace(/\.min$/, '');

  return normalized;
}

function ensureValidEntry(value) {
  const normalized = normalizeEntryName(value);
  if (!normalized)
    return null;
  if (!ENTRY_MAP.has(normalized))
    throw new Error(`Unknown frontend entry "${value}". Known entries: ${Array.from(ENTRY_MAP.keys()).join(', ')}.`);
  return normalized;
}

function toPublicPath(relative) {
  return path.posix.join(PUBLIC_ASSET_PREFIX, relative);
}

function loadProductionManifest() {
  if (cachedManifest)
    return cachedManifest;
  try {
    const data = fs.readFileSync(VITE_MANIFEST_PATH, 'utf8');
    cachedManifest = JSON.parse(data);
  } catch (error) {
    error.message = `Unable to load Vite manifest at ${VITE_MANIFEST_PATH}. Run "npm run build" before starting the server. Original error: ${error.message}`;
    throw error;
  }
  return cachedManifest;
}

function collectImportedCss(manifest, manifestKey, collectedCss, seen = new Set()) {
  if (seen.has(manifestKey))
    return;
  seen.add(manifestKey);

  const record = manifest[manifestKey];
  if (!record)
    return;

  if (Array.isArray(record.css))
    record.css.forEach(cssPath => collectedCss.add(toPublicPath(cssPath)));

  if (Array.isArray(record.imports))
    record.imports.forEach(depKey => collectImportedCss(manifest, depKey, collectedCss, seen));
}

function getDevManifest() {
  const manifest = {};
  ENTRY_MAP.forEach((sourcePath, entryName) => {
    manifest[sourcePath] = {
      file: `${DEV_ENTRY_PREFIX}${entryName}.js`,
      isEntry: true,
      name: entryName,
      src: sourcePath
    };
  });
  return manifest;
}

function getManifest() {
  return shouldUseProdBuild() ? loadProductionManifest() : getDevManifest();
}

function getClientAssets(requestedEntries) {
  const ordered = [];
  if (Array.isArray(requestedEntries)) {
    const seen = new Set();
    requestedEntries.forEach(entry => {
      const normalized = ensureValidEntry(entry);
      if (normalized && normalized !== 'lib' && !seen.has(normalized)) {
        seen.add(normalized);
        ordered.push(normalized);
      }
    });
  }

  const orderedEntries = ['lib', ...ordered];
  const scripts = new Set();
  const styles = new Set();

  if (shouldUseProdBuild()) {
    const manifest = loadProductionManifest();

    orderedEntries.forEach(entryName => {
      const manifestKey = ENTRY_MAP.get(entryName);
      const record = manifest[manifestKey];

      if (!record)
        throw new Error(`Missing Vite manifest entry for "${manifestKey}". Run "npm run build" to refresh assets.`);

      scripts.add(toPublicPath(record.file));

      if (Array.isArray(record.css))
        record.css.forEach(cssPath => styles.add(toPublicPath(cssPath)));

      if (Array.isArray(record.imports))
        record.imports.forEach(depKey => collectImportedCss(manifest, depKey, styles));
    });
  } else {
    scripts.add(DEV_CLIENT_ENTRY);
    orderedEntries.forEach(entryName => scripts.add(`${DEV_ENTRY_PREFIX}${entryName}.js`));
  }

  return {
    scripts: Array.from(scripts),
    styles: Array.from(styles)
  };
}

function resetManifestCache() {
  cachedManifest = null;
}

module.exports = {
  ENTRY_MAP,
  getClientAssets,
  getManifest,
  resetManifestCache
};
