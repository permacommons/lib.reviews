'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const VITE_MANIFEST_PATH = path.join(PROJECT_ROOT, 'build', 'vite', '.vite', 'manifest.json');
const PUBLIC_ASSET_PREFIX = '/assets/';
const DEV_CLIENT_ENTRY = path.posix.join(PUBLIC_ASSET_PREFIX, '@vite/client');
const DEV_ENTRY_STYLES = new Map([
  // Ensure core styles are linked eagerly during development to avoid a flash of
  // unstyled content while Vite injects CSS via JS.
  ['lib', [
    'frontend/styles/vendor.css',
    'frontend/styles/style.less'
  ]]
]);

const entryDefinitions = require('../config/frontend-entries.json');

const ENTRY_MAP = new Map(Object.entries(entryDefinitions));

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
      file: toPublicPath(sourcePath),
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
    orderedEntries.forEach(entryName => {
      const sourcePath = ENTRY_MAP.get(entryName);

      if (!sourcePath)
        throw new Error(`Unknown frontend entry "${entryName}". Known entries: ${Array.from(ENTRY_MAP.keys()).join(', ')}.`);

      scripts.add(toPublicPath(sourcePath));

      const stylesForEntry = DEV_ENTRY_STYLES.get(entryName);
      if (Array.isArray(stylesForEntry))
        stylesForEntry.forEach(stylePath => styles.add(toPublicPath(stylePath)));
    });
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
