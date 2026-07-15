#!/usr/bin/env node
// Bench Atlas — single-file local server.
// Serves the viewer SPA, the existing reference guide, and /devices/ statically,
// plus a small JSON API. LAN only by design: no auth, no HTTPS.

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config — no hardcoded absolute paths. Repo root derived from this file.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

function loadEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
    }
  }
  return env;
}

const env = loadEnv();
const PORT = parseInt(process.env.PORT || env.PORT || '8420', 10);
const DEVICES_DIR = path.resolve(REPO_ROOT, process.env.DEVICES_DIR || env.DEVICES_DIR || 'devices');
const VIEWER_DIR = path.join(__dirname, 'viewer');
const REFERENCE_HTML = path.join(REPO_ROOT, 'audio_bench_reference.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': MIME['.json'] });
}

function fail(res, status, message) {
  sendJSON(res, status, { error: message });
}

// Resolve a URL path inside a base directory, refusing traversal.
function safeJoin(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const resolved = path.resolve(baseDir, '.' + path.sep + decoded);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

async function serveFile(res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return fail(res, 404, 'not found: ' + path.basename(filePath));
  }
  if (!stat.isFile()) return fail(res, 404, 'not a file');
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Atomic write: temp file in the same directory, then rename.
async function atomicWriteJSON(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.tmp-' + crypto.randomBytes(4).toString('hex'));
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fsp.rename(tmp, filePath);
}

function validSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

// ---------------------------------------------------------------------------
// Payload validation — reject bad shapes loudly, never write garbage.
// ---------------------------------------------------------------------------

function isNormCoord(n) {
  return typeof n === 'number' && n >= 0 && n <= 1;
}

function validateAnnotations(data) {
  if (!Array.isArray(data)) return 'annotations must be an array';
  for (const [i, a] of data.entries()) {
    const at = `annotations[${i}]`;
    if (typeof a !== 'object' || a === null) return `${at} must be an object`;
    if (typeof a.id !== 'string' || !a.id) return `${at}.id must be a non-empty string`;
    if (!Number.isInteger(a.page) || a.page < 1) return `${at}.page must be a positive integer`;
    if (typeof a.bbox !== 'object' || a.bbox === null) return `${at}.bbox must be an object`;
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!isNormCoord(a.bbox[k])) return `${at}.bbox.${k} must be a number in [0,1]`;
    }
    if (typeof a.designator !== 'string' || !a.designator) return `${at}.designator must be a non-empty string`;
  }
  return null;
}

function validateMods(data) {
  if (!Array.isArray(data)) return 'mods must be an array';
  for (const [i, m] of data.entries()) {
    const at = `mods[${i}]`;
    if (typeof m !== 'object' || m === null) return `${at} must be an object`;
    if (typeof m.id !== 'string' || !m.id) return `${at}.id must be a non-empty string`;
    if (typeof m.title !== 'string' || !m.title) return `${at}.title must be a non-empty string`;
    if (!['planned', 'installed', 'reverted'].includes(m.status)) {
      return `${at}.status must be planned|installed|reverted`;
    }
  }
  return null;
}

function validatePaths(data) {
  if (!Array.isArray(data)) return 'paths must be an array';
  for (const [i, p] of data.entries()) {
    const at = `paths[${i}]`;
    if (typeof p !== 'object' || p === null) return `${at} must be an object`;
    if (typeof p.id !== 'string' || !p.id) return `${at}.id must be a non-empty string`;
    if (typeof p.name !== 'string' || !p.name) return `${at}.name must be a non-empty string`;
    if (!Array.isArray(p.steps)) return `${at}.steps must be an array`;
    for (const [j, s] of p.steps.entries()) {
      if (typeof s.designator !== 'string' || !s.designator) return `${at}.steps[${j}].designator must be a non-empty string`;
      if (!Number.isInteger(s.page) || s.page < 1) return `${at}.steps[${j}].page must be a positive integer`;
    }
  }
  return null;
}

const PUT_TARGETS = {
  annotations: { file: 'annotations.json', validate: validateAnnotations },
  mods: { file: 'mods.json', validate: validateMods },
  paths: { file: 'paths.json', validate: validatePaths },
};

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

const PAGE_TYPES = ['schematic', 'pcb', 'block', 'photo', 'partslist', 'text', 'mod', 'other'];

const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// POST /api/devices — create a custom device (no manual/indexer required)
async function handleCreateDevice(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
  } catch (e) {
    return fail(res, 400, 'malformed JSON: ' + e.message);
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return fail(res, 400, 'name is required');
  }
  const slug = slugify(body.name);
  if (!validSlug(slug)) return fail(res, 400, `name produces invalid slug: "${slug}"`);
  const deviceDir = path.join(DEVICES_DIR, slug);
  if (fs.existsSync(deviceDir)) return fail(res, 409, `device already exists: ${slug}`);

  await fsp.mkdir(path.join(deviceDir, 'pages'), { recursive: true });
  await fsp.mkdir(path.join(deviceDir, 'photos'), { recursive: true });
  await atomicWriteJSON(path.join(deviceDir, 'meta.json'), {
    name: body.name.trim(),
    model: typeof body.model === 'string' ? body.model.trim() : '',
    notes: typeof body.notes === 'string' ? body.notes.trim() : '',
    pages: [],
  });
  for (const f of ['annotations.json', 'mods.json', 'paths.json']) {
    await atomicWriteJSON(path.join(deviceDir, f), []);
  }
  sendJSON(res, 201, { ok: true, slug });
}

// POST /api/devices/:slug/pages — raw image body; query: type, title
async function handlePageUpload(req, res, slug, query) {
  if (!validSlug(slug)) return fail(res, 400, `invalid device slug: ${slug}`);
  const deviceDir = path.join(DEVICES_DIR, slug);
  const metaPath = path.join(deviceDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return fail(res, 404, `no such device: ${slug}`);

  const ext = IMAGE_EXT[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) return fail(res, 400, 'content-type must be image/png, image/jpeg, or image/webp');
  const type = query.get('type') || 'other';
  if (!PAGE_TYPES.includes(type)) {
    return fail(res, 400, `type must be one of: ${PAGE_TYPES.join(', ')}`);
  }
  const title = (query.get('title') || '').slice(0, 200);

  let body;
  try {
    body = await readBody(req, 32 * 1024 * 1024);
  } catch (e) {
    return fail(res, 413, e.message);
  }
  if (body.length === 0) return fail(res, 400, 'empty image body');

  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  if (!Array.isArray(meta.pages)) meta.pages = [];

  // unique sequential filename that never collides with indexer pages
  let n = meta.pages.length + 1;
  let file;
  do {
    file = `upload-${String(n).padStart(2, '0')}${ext}`;
    n++;
  } while (fs.existsSync(path.join(deviceDir, 'pages', file)));

  await fsp.mkdir(path.join(deviceDir, 'pages'), { recursive: true });
  await fsp.writeFile(path.join(deviceDir, 'pages', file), body);
  // uploads carry no index-time inverted copy; the viewer shows them original
  meta.pages.push({ file, inv: null, type, title });
  await atomicWriteJSON(metaPath, meta);
  sendJSON(res, 201, { ok: true, file, page: meta.pages.length, meta });
}

async function listDevices() {
  let entries = [];
  try {
    entries = await fsp.readdir(DEVICES_DIR, { withFileTypes: true });
  } catch {
    return []; // no devices dir yet — empty library
  }
  const devices = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(DEVICES_DIR, e.name, 'meta.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      devices.push({
        slug: e.name,
        name: meta.name || e.name,
        model: meta.model || '',
        notes: meta.notes || '',
        pageCount: Array.isArray(meta.pages) ? meta.pages.length : 0,
      });
    } catch {
      // folder without valid meta.json — skip silently, not a device
    }
  }
  devices.sort((a, b) => a.name.localeCompare(b.name));
  return devices;
}

async function handlePut(req, res, slug, target) {
  const spec = PUT_TARGETS[target];
  if (!spec) return fail(res, 404, `unknown resource: ${target}`);
  if (!validSlug(slug)) return fail(res, 400, `invalid device slug: ${slug}`);

  const deviceDir = path.join(DEVICES_DIR, slug);
  if (!fs.existsSync(path.join(deviceDir, 'meta.json'))) {
    return fail(res, 404, `no such device: ${slug}`);
  }

  let body;
  try {
    body = await readBody(req, 32 * 1024 * 1024);
  } catch (e) {
    return fail(res, 413, e.message);
  }
  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch (e) {
    return fail(res, 400, 'malformed JSON: ' + e.message);
  }
  const err = spec.validate(data);
  if (err) return fail(res, 400, 'validation failed: ' + err);

  await atomicWriteJSON(path.join(deviceDir, spec.file), data);
  sendJSON(res, 200, { ok: true, count: data.length });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // --- API ---
    if (p === '/api/devices' && req.method === 'GET') {
      return sendJSON(res, 200, await listDevices());
    }
    const putMatch = p.match(/^\/api\/devices\/([^/]+)\/(annotations|mods|paths)$/);
    if (putMatch && req.method === 'PUT') {
      return await handlePut(req, res, putMatch[1], putMatch[2]);
    }
    if (p === '/api/devices' && req.method === 'POST') {
      return await handleCreateDevice(req, res);
    }
    const pageMatch = p.match(/^\/api\/devices\/([^/]+)\/pages$/);
    if (pageMatch && req.method === 'POST') {
      return await handlePageUpload(req, res, pageMatch[1], url.searchParams);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'method not allowed');
    }

    // --- Reference guide (existing file, served unmodified) ---
    if (p === '/reference' || p === '/reference/') {
      return serveFile(res, REFERENCE_HTML);
    }

    // --- Device data (images + JSON) ---
    if (p.startsWith('/devices/')) {
      const filePath = safeJoin(DEVICES_DIR, p.slice('/devices/'.length));
      if (!filePath) return fail(res, 400, 'bad path');
      return serveFile(res, filePath);
    }

    // --- Viewer SPA ---
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const filePath = safeJoin(VIEWER_DIR, rel);
    if (!filePath) return fail(res, 400, 'bad path');
    return serveFile(res, filePath);
  } catch (e) {
    console.error(e);
    fail(res, 500, 'internal error: ' + e.message);
  }
});

function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Bench Atlas');
  console.log(`  local:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  LAN:    http://${a}:${PORT}`);
  console.log(`  devices: ${DEVICES_DIR}`);
});
