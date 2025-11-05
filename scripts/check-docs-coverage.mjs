#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    json: 'static/devdocs/typedoc.json',
    areas: ['util', 'dal', 'routes', 'bootstrap', 'adapters', 'models', 'tools', 'maintenance'],
    threshold: 1.0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' && argv[i + 1]) {
      args.json = argv[++i];
      continue;
    }
    if (a === '--areas' && argv[i + 1]) {
      args.areas = argv[++i]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === '--threshold' && argv[i + 1]) {
      args.threshold = Number(argv[++i]);
      continue;
    }
  }
  return args;
}

function readJson(file) {
  const data = fs.readFileSync(file, 'utf8');
  return JSON.parse(data);
}

function flattenText(summary) {
  if (!summary || !Array.isArray(summary)) return '';
  return summary
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function hasDocComment(ref) {
  const commentText = flattenText(ref?.comment?.summary);
  if (commentText.length > 0) return true;
  if (Array.isArray(ref?.signatures)) {
    for (const sig of ref.signatures) {
      const sigText = flattenText(sig?.comment?.summary);
      if (sigText.length > 0) return true;
    }
  }
  return false;
}

function getPrimarySource(ref) {
  const s = ref?.sources?.[0];
  if (!s) return undefined;
  const file = s.file ?? s.fileName ?? s.filePath ?? s.filename;
  const line = s.line ?? s.character ?? undefined;
  return file ? { file, line } : undefined;
}

function areaOfFile(file, areas) {
  if (!file) return undefined;
  const f = String(file).replace(/\\/g, '/');
  // Map bootstrap/dal.ts into the 'dal' area
  if (/^bootstrap\/dal\.ts$/.test(f)) {
    return 'dal';
  }
  for (const area of areas) {
    const re = new RegExp(`(?:^|/)${area}(?:/|$)`);
    if (re.test(f)) return area;
  }
  return undefined;
}

function belongsToArea(ref, areas) {
  const src = getPrimarySource(ref);
  if (!src?.file) return false;
  return !!areaOfFile(src.file, areas);
}

function isExported(ref) {
  const flags = ref?.flags ?? {};
  if (typeof flags.isExported === 'boolean') return flags.isExported;
  // If export flag is missing, assume exported for top-level reflections.
  return true;
}

const TARGET_KINDS = new Set(['Function', 'Class', 'Interface', 'Type alias', 'Enum', 'Variable']);
const TARGET_KIND_IDS = new Set([64, 128, 256, 32, 4, 4194304]);

function getKindName(ref) {
  // Prefer kindString if present
  if (typeof ref?.kindString === 'string' && ref.kindString.length > 0) {
    return ref.kindString;
  }
  // Fallback to numeric kind mapping (TypeDoc ReflectionKind)
  switch (ref?.kind) {
    case 64:
      return 'Function';
    case 128:
      return 'Class';
    case 256:
      return 'Interface';
    case 32:
      return 'Variable';
    case 4:
      return 'Enum';
    case 4194304:
      return 'Type alias';
    default:
      return undefined;
  }
}

function isTargetKind(ref) {
  const name = getKindName(ref);
  if (name) return TARGET_KINDS.has(name);
  if (typeof ref?.kind === 'number') return TARGET_KIND_IDS.has(ref.kind);
  return false;
}

function getTypeDisplay(t) {
  if (!t) return undefined;
  if (typeof t.name === 'string' && t.name.length > 0) return t.name;
  switch (t.type) {
    case 'reference':
      return t.name ?? t.qualifiedName ?? undefined;
    case 'intrinsic':
      return t.name ?? undefined;
    case 'union':
      return (t.types ?? []).map(getTypeDisplay).filter(Boolean).join(' | ') || undefined;
    case 'array': {
      const et = getTypeDisplay(t.elementType);
      return et ? `${et}[]` : 'array';
    }
    case 'reflection':
      return 'object';
    default:
      return undefined;
  }
}

function getRefTypeName(ref) {
  return getTypeDisplay(ref?.type);
}

function isIgnored(ref) {
  const name = typeof ref?.name === 'string' ? ref.name : '';
  // Ignore anonymous/default exports
  if (name === 'default') return true;

  const kind = getKindName(ref);

  // Ignore router constants and variables referencing Router
  if (kind === 'Variable') {
    const lower = name.toLowerCase();
    if (lower === 'router' || lower.endsWith('router')) return true;
    const tname = getRefTypeName(ref);
    if (
      typeof tname === 'string' &&
      (/(^|[.\s])Router$/.test(tname) || /Express\.Router$/.test(tname))
    ) {
      return true;
    }
  }

  // Ignore unnamed function exports (e.g., anonymous defaults)
  if (kind === 'Function' && name === '') return true;

  return false;
}

/**
 * Explicit allowlist of symbols we permit to have no docs for now.
 * Matches by file path and exported reflection name.
 */
const ALLOWLIST = [
  // Router instances in uploads module
  { file: /^routes\/uploads\.ts$/, names: new Set(['stage1Router', 'stage2Router']) },
  // CSRF re-exports (middleware + helpers)
  {
    file: /^util\/csrf\.ts$/,
    names: new Set([
      'csrfSynchronisedProtection',
      'generateToken',
      'getTokenFromRequest',
      'getTokenFromState',
      'invalidCsrfTokenError',
    ]),
  },
];

/**
 * Return true if a reflection should be excluded from doc coverage gates
 * due to an explicit project allowlist rule.
 */
function isAllowlisted(ref, filePath) {
  const name = typeof ref?.name === 'string' ? ref.name : '';
  if (!name || !filePath) return false;
  for (const rule of ALLOWLIST) {
    if (rule.file.test(filePath) && rule.names.has(name)) {
      return true;
    }
  }
  return false;
}

// Collect parameter names from a signature
function getSignatureParamNames(sig) {
  const names = new Set();
  const params = Array.isArray(sig?.parameters) ? sig.parameters : [];
  for (const p of params) {
    if (p && typeof p.name === 'string' && p.name.length > 0) {
      names.add(p.name);
    }
  }
  return names;
}

// Collect parameter names documented via @param tags or per-parameter comments on a signature
function getParamDocsFromSignature(sig, knownParamNames) {
  const documented = new Set();

  // Per-parameter comments (preferred)
  const params = Array.isArray(sig?.parameters) ? sig.parameters : [];
  for (const p of params) {
    const hasParamComment = flattenText(p?.comment?.summary).length > 0;
    if (hasParamComment && typeof p?.name === 'string') {
      documented.add(p.name);
    }
  }

  // Block tags on the signature comment (fallback)
  const blockTags = Array.isArray(sig?.comment?.blockTags) ? sig.comment.blockTags : [];
  for (const tag of blockTags) {
    if (tag?.tag !== '@param') continue;
    // Some TypeDoc versions provide 'name' on the tag; otherwise, the first token of content is the name
    if (typeof tag?.name === 'string' && tag.name && knownParamNames.has(tag.name)) {
      documented.add(tag.name);
      continue;
    }
    const parts = Array.isArray(tag?.content) ? tag.content : [];
    const text = parts
      .map(p => (typeof p.text === 'string' ? p.text : typeof p.code === 'string' ? p.code : ''))
      .join('')
      .trim();
    if (!text) continue;
    const first = text.split(/\s+/)[0];
    if (first && knownParamNames.has(first)) {
      documented.add(first);
    }
  }

  return documented;
}

// Determine which parameters on a function reflection are missing @param documentation
function getMissingParamDocs(ref) {
  if (!Array.isArray(ref?.signatures) || ref.signatures.length === 0) return [];
  const allParams = new Set();
  const documented = new Set();

  for (const sig of ref.signatures) {
    const names = getSignatureParamNames(sig);
    names.forEach(n => allParams.add(n));
    const docs = getParamDocsFromSignature(sig, names);
    docs.forEach(n => documented.add(n));
  }

  const missing = [];
  allParams.forEach(n => {
    if (!documented.has(n)) missing.push(n);
  });
  return missing;
}

function walk(ref, visitor) {
  if (!ref) return;
  visitor(ref);
  if (Array.isArray(ref.children)) {
    for (const c of ref.children) walk(c, visitor);
  }
  if (Array.isArray(ref.signatures)) {
    for (const s of ref.signatures) visitor(s);
  }
}

function calcCoverage(root, areas) {
  const perArea = new Map();
  // Initialize all requested areas to ensure stable reporting, even if zero
  for (const a of areas) {
    perArea.set(a, { count: 0, documented: 0 });
  }
  const missing = [];
  const paramWarnings = [];
  const total = { count: 0, documented: 0 };

  walk(root, ref => {
    const kindName = getKindName(ref);
    if (!isTargetKind(ref)) return;
    if (!isExported(ref)) return;
    if (!belongsToArea(ref, areas)) return;
    if (isIgnored(ref)) return;
    const src = getPrimarySource(ref);
    const filePath = src?.file ? src.file.replace(/\\/g, '/') : '';
    if (isAllowlisted(ref, filePath)) return;
    const area = areaOfFile(filePath, areas);
    if (!area) return;
    const key = area;
    const entry = perArea.get(key) ?? { count: 0, documented: 0 };
    entry.count += 1;
    total.count += 1;

    // Compute param warnings for function reflections (independent of summary coverage)
    if (kindName === 'Function') {
      // Suppress param warnings for Express Router proxies (TypeDoc can misattribute
      // route handler callbacks to router variables as exported "functions").
      const fname = typeof ref?.name === 'string' ? ref.name.toLowerCase() : '';
      const fpath = src?.file ? String(src.file).replace(/\\/g, '/') : '';
      const isRouteProxy =
        /(?:^|\/)routes\//.test(fpath) &&
        (fname.endsWith('router') || fname === 'stage1router' || fname === 'stage2router');
      if (!isRouteProxy) {
        const missingParams = getMissingParamDocs(ref);
        if (Array.isArray(missingParams) && missingParams.length > 0) {
          paramWarnings.push({
            area,
            name: ref.name,
            file: src?.file ?? 'unknown',
            line: src?.line ?? null,
            missingParams,
          });
        }
      }
    }

    const documented = hasDocComment(ref);
    if (documented) {
      entry.documented += 1;
      total.documented += 1;
    } else {
      missing.push({
        area,
        kind: kindName ?? String(ref.kind ?? 'unknown'),
        name: ref.name,
        file: src?.file ?? 'unknown',
        line: src?.line ?? null,
      });
    }
    perArea.set(key, entry);
  });

  return { perArea, missing, total, paramWarnings };
}

function formatPercent(n) {
  return (n * 100).toFixed(1) + '%';
}

function printReport(result, threshold) {
  const lines = [];
  lines.push('Documentation coverage report (exported API in selected areas):');
  for (const [area, { count, documented }] of result.perArea.entries()) {
    const pct = count === 0 ? 100 : Math.round((documented / count) * 1000) / 10;
    lines.push(`- ${area}: ${documented}/${count} (${pct}%)`);
  }
  const totalPct =
    result.total.count === 0
      ? 100
      : Math.round((result.total.documented / result.total.count) * 1000) / 10;
  lines.push(`- total: ${result.total.documented}/${result.total.count} (${totalPct}%)`);

  // Warnings for functions missing @param docs (non-fatal)
  if (Array.isArray(result.paramWarnings) && result.paramWarnings.length > 0) {
    lines.push('');
    lines.push('Parameter documentation warnings (@param missing):');
    for (const w of result.paramWarnings) {
      const loc = w.line != null ? `${w.file}:${w.line}` : w.file;
      lines.push(
        `- [${w.area}] Function ${w.name} at ${loc} -> missing @param: ${w.missingParams.join(', ')}`
      );
    }
  }

  // Strict gate: fail if any function or class lacks documentation
  const isFuncOrClass = k => {
    const s = String(k);
    return s === 'Function' || s === 'Class' || s === '64' || s === '128';
  };
  const missingCritical = result.missing.filter(m => isFuncOrClass(m.kind));

  if (missingCritical.length > 0) {
    lines.push('');
    lines.push('Critical missing documentation for functions/classes:');
    for (const m of missingCritical) {
      const loc = m.line != null ? `${m.file}:${m.line}` : m.file;
      lines.push(`- [${m.area}] ${m.kind} ${m.name} at ${loc}`);
    }
    console.log(lines.join('\n'));
    console.error(`Function/class documentation missing for ${missingCritical.length} item(s).`);
    process.exit(1);
  }

  // Informational list of other missing docs (interfaces/type aliases/etc.)
  if (result.missing.length > 0) {
    lines.push('');
    lines.push('Missing documentation for:');
    for (const m of result.missing) {
      const loc = m.line != null ? `${m.file}:${m.line}` : m.file;
      lines.push(`- [${m.area}] ${m.kind} ${m.name} at ${loc}`);
    }
  }

  console.log(lines.join('\n'));
  const achieved = result.total.count === 0 ? 1 : result.total.documented / result.total.count;
  if (achieved < threshold) {
    console.error(
      `Documentation coverage below threshold: ${(achieved * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}%`
    );
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const jsonPath = path.resolve(args.json);
  if (!fs.existsSync(jsonPath)) {
    console.error(
      `TypeDoc JSON not found: ${jsonPath}. Run: typedoc --options typedoc.json --json ${args.json}`
    );
    process.exit(1);
  }
  let root;
  try {
    root = readJson(jsonPath);
  } catch (e) {
    console.error(`Failed to read TypeDoc JSON at ${jsonPath}:`, e);
    process.exit(1);
  }
  const areas = args.areas;
  const result = calcCoverage(root, areas);
  printReport(result, args.threshold);
}

main();
