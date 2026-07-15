// Bench Atlas viewer — vanilla JS, no build step.
// Stage 1: library home + page viewer (pan/zoom, invert toggle).
// Stage 2: region hit-testing, HUD info cards, designator cross-linking.

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  devices: [],        // library listing
  device: null,       // { slug, meta, annotations, mods }
  pageIndex: 0,       // 0-based index into meta.pages
  invert: true,       // global toggle: scope-look inverted line art by default
  showRegions: false, // region outlines OFF by default
  selected: null,     // selected annotation object
  pendingFocus: null, // annotation id to select+center after next page load
  review: false,      // review mode: edit cards, queue, region drawing
  drawMode: false,    // review sub-mode: drag draws a new region
  drawRect: null,     // in-progress rubber-band rect (normalized coords)
  editing: null,      // { working, original, isNew } — region open in the edit card
  pendingReviewFocus: false, // next pendingFocus jump should open the edit card, not the info card
  view: { scale: 1, tx: 0, ty: 0 },  // canvas transform
  imgSize: { w: 0, h: 0 },

  activePath: null,   // path object while isolation mode is on
  activeStep: 0,       // index into activePath.steps
  bendDrag: null,      // { stepIndex } while dragging a connector's bend handle
  space: 'atlas',      // 'atlas' | 'mods' — which tab within a device is showing
  modDraft: null,      // { anchorDesignator, anchorPage, ... } being composed by "new mod from here"
};

const $ = (id) => document.getElementById(id);

const el = {
  library: $('library'),
  deviceGrid: $('device-grid'),
  libraryEmpty: $('library-empty'),
  viewer: $('viewer'),
  viewport: $('viewport'),
  canvas: $('canvas'),
  pageImg: $('page-img'),
  regions: $('regions'),
  infocard: $('infocard'),
  editcard: $('editcard'),
  pageMenu: $('page-menu'),
  reviewBar: $('review-bar'),
  queuePanel: $('queue-panel'),
  noPages: $('no-pages'),
  addpagePanel: $('addpage-panel'),
  apFile: $('ap-file'),
  apType: $('ap-type'),
  apTitle: $('ap-title'),
  newDeviceForm: $('new-device-form'),
  ndName: $('nd-name'),
  ndModel: $('nd-model'),
  ndCancel: $('nd-cancel'),
  apCancel: $('ap-cancel'),
  btnBack: $('btn-back'),
  btnInvert: $('btn-invert'),
  btnRegions: $('btn-regions'),
  btnReview: $('btn-review'),
  btnQueue: $('btn-queue'),
  btnDraw: $('btn-draw'),
  btnAddPage: $('btn-addpage'),
  btnAddPageEmpty: $('btn-addpage-empty'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnPageList: $('btn-pagelist'),
  pgNum: $('pg-num'),
  tbTitle: $('tb-title'),
  pager: $('pager'),
  stDevice: $('st-device'),
  stPage: $('st-page'),
  stZoom: $('st-zoom'),
  stPath: $('st-path'),
  stRegions: $('st-regions'),

  deviceTabs: $('device-tabs'),
  tabAtlas: $('tab-atlas'),
  tabMods: $('tab-mods'),
  btnRef: $('btn-ref'),

  btnPath: $('btn-path'),
  pathOverlay: $('path-overlay'),
  pathPicker: $('path-picker'),
  pathStepbar: $('path-stepbar'),
  btnPathPrev: $('btn-path-prev'),
  btnPathNext: $('btn-path-next'),
  btnPathExit: $('btn-path-exit'),
  pathStepName: $('path-step-name'),
  pathStepLevel: $('path-step-level'),

  btnSearch: $('btn-search'),
  searchPanel: $('search-panel'),
  searchInput: $('search-input'),
  searchModsOnly: $('search-mods-only'),
  btnSearchClose: $('btn-search-close'),
  searchResults: $('search-results'),

  modsSpace: $('mods-space'),
  modsTimeline: $('mods-timeline'),
  btnModNew: $('btn-mod-new'),
  modForm: $('mod-form'),
  modFormTitle: $('mod-form-title'),
  modFormAnchor: $('mod-form-anchor'),
  mfTitle: $('mf-title'),
  mfStatus: $('mf-status'),
  mfDate: $('mf-date'),
  mfOriginal: $('mf-original'),
  mfInstalled: $('mf-installed'),
  mfReason: $('mf-reason'),
  mfDelete: $('mf-delete'),
  mfCancel: $('mf-cancel'),

  referenceView: $('reference-view'),
  referenceFrame: $('reference-frame'),
};

function hideAllSections() {
  el.library.classList.add('hidden');
  el.viewer.classList.add('hidden');
  el.modsSpace.classList.add('hidden');
  el.referenceView.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Routing — #/ (library) or #/d/<slug>/p/<n> (1-based page)
// ---------------------------------------------------------------------------

function parseHash() {
  let m = location.hash.match(/^#\/d\/([a-z0-9-]+)\/p\/(\d+)$/);
  if (m) return { view: 'page', slug: m[1], page: parseInt(m[2], 10) };
  m = location.hash.match(/^#\/d\/([a-z0-9-]+)\/mods$/);
  if (m) return { view: 'mods', slug: m[1] };
  m = location.hash.match(/^#\/ref(?:\/([a-z0-9_-]+))?$/i);
  if (m) return { view: 'ref', anchor: m[1] || null };
  return { view: 'library' };
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const r = parseHash();
  if (r.view === 'library') {
    showLibrary();
  } else if (r.view === 'page') {
    state.space = 'atlas';
    state.lastAtlasPage = r.page;
    await showPage(r.slug, r.page);
  } else if (r.view === 'mods') {
    state.space = 'mods';
    await showModsSpace(r.slug);
  } else if (r.view === 'ref') {
    showReference(r.anchor);
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function loadDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error('device list failed: ' + res.status);
  state.devices = await res.json();
}

function showLibrary() {
  state.device = null;
  state.editing = null;
  state.activePath = null;
  clearSelection();
  hideAllSections();
  el.pageMenu.classList.add('hidden');
  el.editcard.classList.add('hidden');
  el.queuePanel.classList.add('hidden');
  el.addpagePanel.classList.add('hidden');
  el.pathPicker.classList.add('hidden');
  el.pathStepbar.classList.add('hidden');
  el.searchPanel.classList.add('hidden');
  el.newDeviceForm.classList.add('hidden');
  el.newDeviceForm.reset();
  el.library.classList.remove('hidden');
  el.btnBack.classList.add('hidden');
  el.btnInvert.classList.add('hidden');
  el.btnRegions.classList.add('hidden');
  el.btnReview.classList.add('hidden');
  el.btnSearch.classList.add('hidden');
  el.btnPath.classList.add('hidden');
  el.deviceTabs.classList.add('hidden');
  el.pager.classList.add('hidden');
  el.tbTitle.textContent = 'BENCH ATLAS';

  el.deviceGrid.innerHTML = '';
  el.libraryEmpty.classList.toggle('hidden', state.devices.length > 0);
  for (const d of state.devices) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.innerHTML =
      `<div class="d-name">${esc(d.name)}</div>` +
      `<div class="d-model">${esc(d.model)}</div>` +
      `<div class="d-meta">${d.pageCount} PAGES</div>`;
    card.addEventListener('click', () => navigate(`#/d/${d.slug}/p/1`));
    el.deviceGrid.appendChild(card);
  }

  // custom devices are first-class: no manual or indexer required
  const newCard = document.createElement('div');
  newCard.className = 'device-card new-device';
  newCard.textContent = '+ NEW DEVICE';
  newCard.addEventListener('click', () => {
    el.newDeviceForm.classList.remove('hidden');
    el.ndName.focus();
  });
  el.deviceGrid.appendChild(newCard);

  el.stDevice.textContent = '–';
  el.stPage.textContent = '–';
  el.stZoom.textContent = '–';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// New-device flow — custom devices are first-class, no manual/indexer needed.
// ---------------------------------------------------------------------------

el.ndCancel.addEventListener('click', () => {
  el.newDeviceForm.classList.add('hidden');
  el.newDeviceForm.reset();
});

el.newDeviceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.ndName.value.trim();
  if (!name) return;
  const res = await fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model: el.ndModel.value.trim() }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Could not create device: ' + (err.error || res.status));
    return;
  }
  const { slug } = await res.json();
  el.newDeviceForm.classList.add('hidden');
  el.newDeviceForm.reset();
  await loadDevices();
  navigate(`#/d/${slug}/p/1`);
});

// ---------------------------------------------------------------------------
// Device / page loading
// ---------------------------------------------------------------------------

async function fetchJSONOr(url, fallback) {
  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

async function loadDevice(slug) {
  if (state.device && state.device.slug === slug) return;
  const res = await fetch(`/devices/${slug}/meta.json`);
  if (!res.ok) throw new Error(`meta.json for ${slug}: ${res.status}`);
  const meta = await res.json();
  const [annotations, mods, paths] = await Promise.all([
    fetchJSONOr(`/devices/${slug}/annotations.json`, []),
    fetchJSONOr(`/devices/${slug}/mods.json`, []),
    fetchJSONOr(`/devices/${slug}/paths.json`, []),
  ]);
  state.device = { slug, meta, annotations, mods, paths };
}

function currentPage() {
  return state.device.meta.pages[state.pageIndex];
}

function pageAnnotations() {
  return state.device.annotations.filter((a) => a.page === state.pageIndex + 1);
}

// A page renders inverted when: it has an inverted copy AND the global toggle is on.
// Photos never have one, so they always render original.
function pageImageURL() {
  const p = currentPage();
  const file = (state.invert && p.inv) ? p.inv : p.file;
  return `/devices/${state.device.slug}/pages/${file}`;
}

async function showPage(slug, pageNum) {
  try {
    await loadDevice(slug);
  } catch (e) {
    console.error(e);
    navigate('#/');
    return;
  }

  state.editing = null;
  el.editcard.classList.add('hidden');
  el.editcard.classList.add('hidden-slide');
  el.addpagePanel.classList.add('hidden');
  el.searchPanel.classList.add('hidden');
  el.pathPicker.classList.add('hidden');
  if (!state.pendingFocus) clearSelection();

  hideAllSections();
  el.viewer.classList.remove('hidden');
  el.btnBack.classList.remove('hidden');
  el.deviceTabs.classList.remove('hidden');
  el.tabAtlas.classList.add('on');
  el.tabMods.classList.remove('on');
  el.tbTitle.textContent = (state.device.meta.name || slug).toUpperCase();

  const pages = state.device.meta.pages || [];

  // Custom devices start with zero pages — that is a normal state, not an
  // error: offer the add-page flow right where the missing page would be.
  if (pages.length === 0) {
    el.pager.classList.add('hidden');
    el.btnInvert.classList.add('hidden');
    el.btnRegions.classList.add('hidden');
    el.btnReview.classList.add('hidden');
    el.btnSearch.classList.add('hidden');
    el.btnPath.classList.add('hidden');
    el.reviewBar.classList.add('hidden');
    el.queuePanel.classList.add('hidden');
    el.pageMenu.classList.add('hidden');
    el.pathStepbar.classList.add('hidden');
    el.pageImg.classList.add('hidden');
    el.regions.innerHTML = '';
    el.pathOverlay.innerHTML = '';
    el.noPages.classList.remove('hidden');
    el.stDevice.textContent = state.device.slug.toUpperCase();
    el.stPage.textContent = 'NO PAGES';
    el.stZoom.textContent = '–';
    el.stPath.textContent = '–';
    el.stRegions.textContent = '–';
    return;
  }

  el.noPages.classList.add('hidden');
  el.pageImg.classList.remove('hidden');
  el.pager.classList.remove('hidden');
  el.btnInvert.classList.remove('hidden');
  el.btnRegions.classList.remove('hidden');
  el.btnReview.classList.remove('hidden');
  el.btnSearch.classList.remove('hidden');
  el.btnPath.classList.remove('hidden');

  state.pageIndex = Math.min(Math.max(pageNum - 1, 0), pages.length - 1);
  el.btnInvert.classList.toggle('on', state.invert);
  el.btnRegions.classList.toggle('on', state.showRegions);
  el.btnReview.classList.toggle('on', state.review);
  el.reviewBar.classList.toggle('hidden', !state.review);
  el.pgNum.textContent = `${state.pageIndex + 1}/${pages.length}`;

  renderPageMenu();
  await loadPageImage(true);

  if (state.pendingFocus) {
    const target = state.device.annotations.find((a) => a.id === state.pendingFocus);
    const wantReview = state.pendingReviewFocus;
    state.pendingFocus = null;
    state.pendingReviewFocus = false;
    if (target && target.page === state.pageIndex + 1) {
      if (wantReview) {
        openEditCard(target, { isNew: false });
        centerOnRegion(target);
      } else {
        selectAnnotation(target, { center: true });
      }
    }
  }

  renderRegions();
  applyPathDimming();
  renderPathOverlay();
  if (state.activePath) {
    el.pathStepbar.classList.remove('hidden');
    updatePathStepBar();
    const step = state.activePath.steps[state.activeStep];
    if (step && step.page === state.pageIndex + 1) centerOnStepRegion(step);
  } else {
    el.pathStepbar.classList.add('hidden');
  }
  updateStatus();
}

function loadPageImage(refit) {
  return new Promise((resolve) => {
    const img = el.pageImg;
    img.onload = () => {
      state.imgSize = { w: img.naturalWidth, h: img.naturalHeight };
      if (refit) fitToView();
      renderRegions();
      resolve();
    };
    img.onerror = () => {
      console.error('image failed to load:', img.src);
      resolve();
    };
    img.src = pageImageURL();
  });
}

function renderPageMenu() {
  el.pageMenu.innerHTML = '';
  state.device.meta.pages.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'pm-item' + (i === state.pageIndex ? ' current' : '');
    item.innerHTML =
      `<span class="pm-num">${String(i + 1).padStart(2, '0')}</span>` +
      `<span>${esc(p.title || p.file)}</span>` +
      `<span class="pm-type">${esc(p.type || '')}</span>`;
    item.addEventListener('click', () => {
      el.pageMenu.classList.add('hidden');
      navigate(`#/d/${state.device.slug}/p/${i + 1}`);
    });
    el.pageMenu.appendChild(item);
  });
}

function gotoPage(delta) {
  const n = state.pageIndex + delta;
  if (n < 0 || n >= state.device.meta.pages.length) return;
  navigate(`#/d/${state.device.slug}/p/${n + 1}`);
}

// ---------------------------------------------------------------------------
// Region overlay — SVG in image-pixel space; strokes stay 1.5px at any zoom.
// Color is provenance, nothing else.
// ---------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';

function regionClass(a) {
  if (state.selected && a.id === state.selected.id) return 'rg-selected';
  if (a.flags && a.flags.length > 0) return 'rg-flagged';
  if (a.verified) return 'rg-verified';
  return 'rg-unverified';
}

function svgRect(w, h, bbox, cls) {
  const r = document.createElementNS(SVGNS, 'rect');
  r.setAttribute('x', bbox.x * w);
  r.setAttribute('y', bbox.y * h);
  r.setAttribute('width', bbox.w * w);
  r.setAttribute('height', bbox.h * h);
  r.setAttribute('class', cls);
  return r;
}

function renderRegions() {
  const svg = el.regions;
  svg.innerHTML = '';
  if (!state.device) return;
  const { w, h } = state.imgSize;
  if (!w || !h) return;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  for (const a of pageAnnotations()) {
    const isSel = state.selected && a.id === state.selected.id;
    if (!state.showRegions && !isSel) continue; // outlines off: selection only
    svg.appendChild(svgRect(w, h, a.bbox, regionClass(a)));
  }

  // A brand-new hand-drawn region isn't in pageAnnotations() until saved.
  if (state.editing && state.editing.isNew) {
    svg.appendChild(svgRect(w, h, state.editing.working.bbox, 'rg-selected'));
  }
  if (state.drawRect) {
    svg.appendChild(svgRect(w, h, state.drawRect, 'rg-draw'));
  }
}

// ---------------------------------------------------------------------------
// Hit-testing — pure math against normalized bboxes (zoom-proof by design)
// ---------------------------------------------------------------------------

function clientToNorm(clientX, clientY) {
  const rect = el.viewport.getBoundingClientRect();
  const { scale, tx, ty } = state.view;
  const ix = (clientX - rect.left - tx) / scale;
  const iy = (clientY - rect.top - ty) / scale;
  return { nx: ix / state.imgSize.w, ny: iy / state.imgSize.h };
}

function hitTest(clientX, clientY) {
  const { nx, ny } = clientToNorm(clientX, clientY);
  let best = null;
  let bestArea = Infinity;
  for (const a of pageAnnotations()) {
    const b = a.bbox;
    if (nx >= b.x && nx <= b.x + b.w && ny >= b.y && ny <= b.y + b.h) {
      const area = b.w * b.h;
      if (area < bestArea) { best = a; bestArea = area; } // smallest region wins
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Selection + info card
// ---------------------------------------------------------------------------

function clearSelection() {
  state.selected = null;
  el.infocard.classList.add('hidden');
  el.infocard.classList.add('hidden-slide');
}

function selectAnnotation(a, opts = {}) {
  state.selected = a;
  if (opts.center) centerOnRegion(a);
  renderRegions();
  showInfoCard(a);
}

// Zoom/pan so the region sits centered at a comfortable magnification.
function centerOnRegion(a) {
  const vp = el.viewport.getBoundingClientRect();
  const { w, h } = state.imgSize;
  const rw = a.bbox.w * w, rh = a.bbox.h * h;
  // region should occupy ~35% of the smaller viewport dimension
  let s = Math.min((vp.width * 0.35) / rw, (vp.height * 0.35) / rh);
  s = Math.min(Math.max(s, fitScale), MAX_SCALE);
  const cx = (a.bbox.x + a.bbox.w / 2) * w;
  const cy = (a.bbox.y + a.bbox.h / 2) * h;
  state.view.scale = s;
  state.view.tx = vp.width / 2 - cx * s;
  state.view.ty = vp.height / 2 - cy * s;
  applyView();
}

const TIER_LABELS = { verified: 'verified', partslist: 'parts list', datasheet: 'datasheet', vision: 'vision', inferred: 'inferred' };

// Never covers the tapped region: card goes to the opposite half of the viewport.
function positionCardForBBox(cardEl, bbox) {
  const vp = el.viewport.getBoundingClientRect();
  const regionCenterY = (bbox.y + bbox.h / 2) * state.imgSize.h * state.view.scale + state.view.ty;
  const placeBottom = regionCenterY < vp.height / 2;
  cardEl.classList.toggle('at-bottom', placeBottom);
  cardEl.classList.toggle('at-top', !placeBottom);
}

function slideIn(cardEl) {
  cardEl.classList.remove('hidden');
  cardEl.classList.add('hidden-slide');
  requestAnimationFrame(() => cardEl.classList.remove('hidden-slide'));
}

function icRow(key, val, extra = '') {
  const v = val == null || val === ''
    ? '<span class="ic-null">—</span>'
    : esc(val);
  return `<div class="ic-row"><span class="ic-key">${key}</span><span class="ic-val">${v}${extra}</span></div>`;
}

function showInfoCard(a) {
  const d = state.device;
  const parts = [];

  // Progressive reveal order: designator+type → value(+tier) → function →
  // signal notes → datasheet. Status: green ✓ verified, amber ⚠ + confidence.
  const status = a.verified
    ? '<span class="ic-status verified">✓ VERIFIED</span>'
    : `<span class="ic-status unverified">⚠ UNVERIFIED · ${Math.round((a.confidence ?? 0) * 100)}%</span>`;

  parts.push(
    `<div class="ic-head">` +
    `<span class="ic-designator">${esc(a.designator)}</span>` +
    `<span class="ic-type">${esc(a.componentType || '')}</span>` +
    status +
    `</div>`
  );

  const tier = a.provenance ? `<span class="ic-tier">${esc(TIER_LABELS[a.provenance] || a.provenance)}</span>` : '';
  parts.push(icRow('value', a.value, tier));
  if (a.function) parts.push(icRow('func', a.function));
  if (a.signalNotes) parts.push(icRow('signal', a.signalNotes));

  if (a.flags && a.flags.length) {
    parts.push(
      '<div class="ic-flags">' +
      a.flags.map((f) => `<span class="ic-flag">${esc(f)}</span>`).join('') +
      '</div>'
    );
  }

  if (a.datasheet && (a.datasheet.pinout || a.datasheet.keySpecs)) {
    const ds = a.datasheet;
    parts.push(
      `<div class="ic-datasheet">` +
      icRow('part', ds.partNumber) +
      (ds.pinout ? icRow('pinout', ds.pinout) : '') +
      (ds.keySpecs ? icRow('specs', ds.keySpecs) : '') +
      `</div>`
    );
  }

  // Installed-mod badge: a pointer only — the Atlas never renders mod content.
  const hasInstalledMod = d.mods.some(
    (m) => m.anchorDesignator === a.designator && m.status === 'installed'
  );
  if (hasInstalledMod) {
    parts.push('<div><span class="ic-modbadge">⚡ MODIFIED — SEE MODS</span></div>');
  }

  // Cross-links: every other appearance of this designator, grouped by page.
  const xrefs = d.annotations.filter(
    (x) => x.designator === a.designator && x.id !== a.id
  );
  if (xrefs.length) {
    parts.push(
      '<div class="ic-xrefs"><div class="ic-xref-label">ALSO ON</div>' +
      xrefs.map((x) => {
        const pg = d.meta.pages[x.page - 1];
        const label = `PG ${x.page} ${(pg && pg.type ? pg.type : '').toUpperCase()}`;
        return `<span class="ic-xref" data-target="${esc(x.id)}" data-page="${x.page}">${label}</span>`;
      }).join('') +
      '</div>'
    );
  }

  parts.push(
    '<div class="ic-actions">' +
    '<button type="button" class="ic-action-btn" id="ic-copy">COPY CONTEXT</button>' +
    '<button type="button" class="ic-action-btn mod-action" id="ic-newmod">+ MOD FROM HERE</button>' +
    '</div>'
  );

  el.infocard.innerHTML = parts.join('');

  positionCardForBBox(el.infocard, a.bbox);

  el.infocard.querySelectorAll('.ic-xref').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.pendingFocus = chip.dataset.target;
      navigate(`#/d/${state.device.slug}/p/${chip.dataset.page}`);
    });
  });

  const copyBtn = el.infocard.querySelector('#ic-copy');
  copyBtn.addEventListener('click', () => copyContext(a, copyBtn));
  el.infocard.querySelector('#ic-newmod').addEventListener('click', () => newModFromHere(a));

  slideIn(el.infocard);
}

// ---------------------------------------------------------------------------
// Review mode — edit fields / mark verified / delete; draw a new region
// (born verified). Saves PUT the whole annotations array to the server.
// ---------------------------------------------------------------------------

function openEditCard(annotation, { isNew }) {
  const working = isNew ? annotation : { ...annotation };
  state.editing = { working, original: isNew ? null : annotation, isNew };
  state.selected = isNew ? working : annotation;
  clearInfoCardOnly();
  renderRegions();
  renderEditCardForm();
  positionCardForBBox(el.editcard, working.bbox);
  slideIn(el.editcard);
}

function clearInfoCardOnly() {
  el.infocard.classList.add('hidden');
  el.infocard.classList.add('hidden-slide');
}

function closeEditCardUI() {
  el.editcard.classList.add('hidden');
  el.editcard.classList.add('hidden-slide');
}

function cancelEdit() {
  state.editing = null;
  closeEditCardUI();
  renderRegions();
}

const EDIT_FIELDS = [
  ['designator', 'designator'],
  ['componentType', 'type'],
  ['value', 'value'],
  ['function', 'func'],
  ['signalNotes', 'signal'],
];

function renderEditCardForm() {
  const { working, isNew } = state.editing;

  const rows = EDIT_FIELDS.map(([field, label]) =>
    `<span class="ec-label">${label}</span>` +
    `<input class="ec-input" data-f="${field}" value="${esc(working[field] || '')}">`
  ).join('');

  const meta = isNew
    ? 'BORN VERIFIED — HAND-DRAWN'
    : `PROVENANCE: ${esc(working.provenance || '')} · ${working.verified ? 'VERIFIED' : 'UNVERIFIED'}`;

  const showVerifyBtn = !isNew && !working.verified;

  el.editcard.innerHTML =
    `<div class="ic-head"><span class="ic-designator">${isNew ? 'NEW REGION' : 'EDIT REGION'}</span></div>` +
    `<div class="ec-grid">${rows}</div>` +
    `<div class="ec-meta">${meta}</div>` +
    `<div class="ec-buttons">` +
    `<button type="button" class="tb-btn ec-verify" id="ec-save">SAVE</button>` +
    (showVerifyBtn ? `<button type="button" class="tb-btn ec-verify" id="ec-verify">&#10003; VERIFY</button>` : '') +
    `<button type="button" class="tb-btn ec-delete" id="ec-delete">DELETE</button>` +
    `<button type="button" class="tb-btn" id="ec-cancel">CANCEL</button>` +
    `</div>`;

  el.editcard.querySelectorAll('.ec-input').forEach((inp) => {
    inp.addEventListener('input', () => { working[inp.dataset.f] = inp.value; });
  });
  el.editcard.querySelector('#ec-save').addEventListener('click', () => commitEdit({ verify: false }));
  const verifyBtn = el.editcard.querySelector('#ec-verify');
  if (verifyBtn) verifyBtn.addEventListener('click', () => commitEdit({ verify: true }));
  el.editcard.querySelector('#ec-delete').addEventListener('click', () => deleteEditing());
  el.editcard.querySelector('#ec-cancel').addEventListener('click', () => cancelEdit());
}

async function saveAnnotations() {
  const res = await fetch(`/api/devices/${state.device.slug}/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.device.annotations),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Save failed: ' + (err.error || res.status));
    return false;
  }
  return true;
}

async function commitEdit({ verify }) {
  const { working, original, isNew } = state.editing;
  if (!working.designator || !working.designator.trim()) {
    alert('designator is required');
    return;
  }
  working.designator = working.designator.trim();
  if (verify) {
    working.verified = true;
    working.provenance = 'verified';
  }

  if (isNew) {
    state.device.annotations.push(working);
  } else {
    const idx = state.device.annotations.findIndex((x) => x.id === original.id);
    if (idx >= 0) state.device.annotations[idx] = working;
  }

  const ok = await saveAnnotations();
  if (!ok) {
    // roll back the local mutation so in-memory state matches disk
    if (isNew) {
      const i = state.device.annotations.indexOf(working);
      if (i >= 0) state.device.annotations.splice(i, 1);
    } else {
      const idx = state.device.annotations.findIndex((x) => x.id === original.id);
      if (idx >= 0) state.device.annotations[idx] = original;
    }
    return;
  }

  state.editing = null;
  state.selected = working;
  closeEditCardUI();
  renderRegions();
  refreshQueueIfOpen();
}

async function deleteEditing() {
  const { original, isNew } = state.editing;
  if (isNew) { cancelEdit(); return; }
  if (!confirm(`Delete region ${original.designator}?`)) return;

  const idx = state.device.annotations.findIndex((x) => x.id === original.id);
  const removed = idx >= 0 ? state.device.annotations.splice(idx, 1)[0] : null;

  const ok = await saveAnnotations();
  if (!ok) {
    if (removed) state.device.annotations.splice(idx, 0, removed);
    return;
  }

  state.editing = null;
  state.selected = null;
  closeEditCardUI();
  renderRegions();
  refreshQueueIfOpen();
}

// ---------------------------------------------------------------------------
// Review queue — flags first, then ascending confidence, across all pages.
// ---------------------------------------------------------------------------

function buildQueue() {
  const items = state.device.annotations.filter((a) => !a.verified || (a.flags && a.flags.length));
  items.sort((a, b) => {
    const af = (a.flags && a.flags.length) ? 1 : 0;
    const bf = (b.flags && b.flags.length) ? 1 : 0;
    if (af !== bf) return bf - af;
    return (a.confidence ?? 1) - (b.confidence ?? 1);
  });
  return items;
}

function renderQueue() {
  const items = buildQueue();
  const rows = items.length === 0
    ? '<div class="q-empty">NOTHING TO REVIEW</div>'
    : items.map((a) => {
      const pg = state.device.meta.pages[a.page - 1];
      const flag = (a.flags && a.flags.length) ? '&#9873;' : '';
      return `<div class="q-item" data-id="${esc(a.id)}" data-page="${a.page}">` +
        `<span class="q-flag-dot">${flag}</span>` +
        `<span class="q-designator">${esc(a.designator)}</span>` +
        `<span class="q-page">PG ${a.page} ${esc((pg && pg.type || '').toUpperCase())}</span>` +
        `<span class="q-conf">${Math.round((a.confidence ?? 0) * 100)}%</span>` +
        `</div>`;
    }).join('');

  el.queuePanel.innerHTML = `<div class="q-head">REVIEW QUEUE — ${items.length}</div>${rows}`;

  el.queuePanel.querySelectorAll('.q-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const page = parseInt(item.dataset.page, 10);
      el.queuePanel.classList.add('hidden');
      if (page === state.pageIndex + 1) {
        const a = state.device.annotations.find((x) => x.id === id);
        if (a) { openEditCard(a, { isNew: false }); centerOnRegion(a); }
      } else {
        state.pendingFocus = id;
        state.pendingReviewFocus = true;
        navigate(`#/d/${state.device.slug}/p/${page}`);
      }
    });
  });
}

function refreshQueueIfOpen() {
  if (!el.queuePanel.classList.contains('hidden')) renderQueue();
}

// ---------------------------------------------------------------------------
// Paths / isolation mode — steps are an ordered component sequence, not wire
// geometry. The connector is an obviously synthetic overlay: it never claims
// to be the copper.
// ---------------------------------------------------------------------------

function pageAnnotationFor(designator, page) {
  return state.device.annotations.find((a) => a.designator === designator && a.page === page);
}

function applyPathDimming() {
  el.pageImg.classList.toggle('path-dimmed', !!state.activePath);
}

async function savePaths() {
  const res = await fetch(`/api/devices/${state.device.slug}/paths`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.device.paths),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Save failed: ' + (err.error || res.status));
    return false;
  }
  return true;
}

function makeBendHandle(svg, w, h, stepIndex, mx, my, from, to) {
  const handle = document.createElementNS(SVGNS, 'circle');
  handle.setAttribute('r', 7);
  handle.setAttribute('cx', mx * w);
  handle.setAttribute('cy', my * h);
  handle.setAttribute('class', 'pv-handle');
  svg.appendChild(handle);

  const p0 = { x: from.x * w, y: from.y * h };
  const p2 = { x: to.x * w, y: to.y * h };
  const connectorEl = handle.previousSibling; // the path element drawConnector just appended

  let dragging = false;
  handle.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    dragging = true;
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const { nx, ny } = clientToNorm(ev.clientX, ev.clientY);
    const bx = clamp01(nx), by = clamp01(ny);
    handle.setAttribute('cx', bx * w);
    handle.setAttribute('cy', by * h);
    connectorEl.setAttribute('d', `M ${p0.x} ${p0.y} Q ${bx * w} ${by * h} ${p2.x} ${p2.y}`);
    state.activePath.steps[stepIndex].bendToNext = { x: bx, y: by };
  });
  handle.addEventListener('pointerup', async (ev) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(ev.pointerId);
    await savePaths();
  });
}

function drawConnector(svg, w, h, stepIndex, from, to, bend) {
  const p0 = { x: from.x * w, y: from.y * h };
  const p2 = { x: to.x * w, y: to.y * h };
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('class', 'pv-connector');
  path.setAttribute('d', bend
    ? `M ${p0.x} ${p0.y} Q ${bend.x * w} ${bend.y * h} ${p2.x} ${p2.y}`
    : `M ${p0.x} ${p0.y} L ${p2.x} ${p2.y}`);
  svg.appendChild(path);

  // hand-shaped, honest: a bend point is a review-mode edit, not AI wire-tracing
  if (state.review) {
    const mid = bend || { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    makeBendHandle(svg, w, h, stepIndex, mid.x, mid.y, from, to);
  }
}

function jumpToStep(idx) {
  const steps = state.activePath.steps;
  if (idx < 0 || idx >= steps.length) return;
  state.activeStep = idx;
  const step = steps[idx];
  if (step.page === state.pageIndex + 1) {
    renderPathOverlay();
    updatePathStepBar();
    centerOnStepRegion(step);
    updateStatus();
  } else {
    navigate(`#/d/${state.device.slug}/p/${step.page}`);
  }
}

// Anchored just outside the step's OWN bbox — not the page's absolute pixel
// edge. Isolation mode zooms in tight on the current step, so an arrow
// pinned to the physical page edge is routinely thousands of px off-screen.
function drawEdgeArrow(svg, w, h, bbox, dir, stepIndex, targetPage) {
  const y = (bbox.y + bbox.h / 2) * h;
  const x = dir === 'next' ? (bbox.x + bbox.w) * w + 20 : bbox.x * w - 20;
  const pts = dir === 'next'
    ? `${x - 14},${y - 16} ${x - 14},${y + 16} ${x + 10},${y}`
    : `${x + 14},${y - 16} ${x + 14},${y + 16} ${x - 10},${y}`;
  const tri = document.createElementNS(SVGNS, 'polygon');
  tri.setAttribute('points', pts);
  tri.setAttribute('class', 'pv-edge-arrow');
  svg.appendChild(tri);

  const label = document.createElementNS(SVGNS, 'text');
  label.setAttribute('x', x);
  label.setAttribute('y', y + 30);
  label.setAttribute('class', 'pv-edge-label');
  label.setAttribute('font-size', 12);
  label.textContent = `PG ${targetPage}`;
  svg.appendChild(label);

  // without this, #viewport's own pointerdown handler (pan/tap tracking) also
  // fires on bubble, calls setPointerCapture, and steals the click's target
  tri.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  tri.addEventListener('click', () => jumpToStep(dir === 'next' ? stepIndex + 1 : stepIndex - 1));
}

function renderPathOverlay() {
  const svg = el.pathOverlay;
  svg.innerHTML = '';
  if (!state.activePath || !state.imgSize.w) {
    svg.removeAttribute('width');
    return;
  }
  const { w, h } = state.imgSize;
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const steps = state.activePath.steps;
  const curPage = state.pageIndex + 1;
  const centers = {};
  const bboxes = {};

  steps.forEach((step, i) => {
    if (step.page !== curPage) return;
    const ann = pageAnnotationFor(step.designator, step.page);
    if (!ann) return;
    centers[i] = { x: ann.bbox.x + ann.bbox.w / 2, y: ann.bbox.y + ann.bbox.h / 2 };
    bboxes[i] = ann.bbox;

    const isCurrent = i === state.activeStep;
    svg.appendChild(svgRect(w, h, ann.bbox, 'pv-region' + (isCurrent ? ' pv-current' : '')));

    const bx = ann.bbox.x * w, by = ann.bbox.y * h;
    const badge = document.createElementNS(SVGNS, 'circle');
    badge.setAttribute('cx', bx);
    badge.setAttribute('cy', by);
    badge.setAttribute('r', 13);
    badge.setAttribute('class', 'pv-badge-bg');
    svg.appendChild(badge);
    const text = document.createElementNS(SVGNS, 'text');
    text.setAttribute('x', bx);
    text.setAttribute('y', by + 1);
    text.setAttribute('class', 'pv-badge-text');
    text.setAttribute('font-size', 14);
    text.textContent = String(i + 1);
    svg.appendChild(text);
  });

  steps.forEach((step, i) => {
    if (step.page !== curPage) return;
    const next = steps[i + 1];
    if (next) {
      if (next.page === curPage && centers[i] && centers[i + 1]) {
        drawConnector(svg, w, h, i, centers[i], centers[i + 1], step.bendToNext);
      } else if (next.page !== curPage && bboxes[i]) {
        drawEdgeArrow(svg, w, h, bboxes[i], 'next', i, next.page);
      }
    }
    const prev = steps[i - 1];
    if (prev && prev.page !== curPage && bboxes[i]) {
      drawEdgeArrow(svg, w, h, bboxes[i], 'prev', i, prev.page);
    }
  });
}

function centerOnStepRegion(step) {
  const ann = pageAnnotationFor(step.designator, step.page);
  if (ann) centerOnRegion(ann);
}

function updatePathStepBar() {
  const path = state.activePath;
  const step = path.steps[state.activeStep];
  el.pathStepName.textContent = `${state.activeStep + 1}/${path.steps.length} · ${step.designator}${step.note ? ' — ' + step.note : ''}`;
  el.pathStepLevel.textContent = step.expectedLevel || '';
  el.btnPathPrev.disabled = state.activeStep === 0;
  el.btnPathNext.disabled = state.activeStep === path.steps.length - 1;
}

function startPath(path) {
  state.activePath = path;
  state.activeStep = 0;
  el.pathStepbar.classList.remove('hidden');
  const first = path.steps[0];
  if (!first) return;
  if (first.page === state.pageIndex + 1) {
    applyPathDimming();
    renderPathOverlay();
    updatePathStepBar();
    centerOnStepRegion(first);
    updateStatus();
  } else {
    navigate(`#/d/${state.device.slug}/p/${first.page}`);
  }
}

function exitPath() {
  state.activePath = null;
  state.activeStep = 0;
  applyPathDimming();
  renderPathOverlay();
  el.pathStepbar.classList.add('hidden');
  updateStatus();
}

function renderPathPicker() {
  const paths = state.device.paths || [];
  el.pathPicker.innerHTML = paths.length === 0
    ? '<div class="pp-empty">NO PATHS DEFINED</div>'
    : paths.map((p) =>
      `<div class="pp-item" data-id="${esc(p.id)}">` +
      `<div class="pp-name">${esc(p.name)}</div>` +
      `<div class="pp-meta">${p.steps.length} STEPS · ${esc(p.source || '')}${p.verified ? ' · VERIFIED' : ' · UNVERIFIED'}</div>` +
      `</div>`
    ).join('');

  el.pathPicker.querySelectorAll('.pp-item').forEach((item) => {
    item.addEventListener('click', () => {
      const path = paths.find((p) => p.id === item.dataset.id);
      el.pathPicker.classList.add('hidden');
      if (path) startPath(path);
    });
  });
}

el.btnPath.addEventListener('click', () => {
  const willShow = el.pathPicker.classList.contains('hidden');
  if (willShow) renderPathPicker();
  el.pathPicker.classList.toggle('hidden', !willShow);
});
el.btnPathPrev.addEventListener('click', () => jumpToStep(state.activeStep - 1));
el.btnPathNext.addEventListener('click', () => jumpToStep(state.activeStep + 1));
el.btnPathExit.addEventListener('click', exitPath);

// ---------------------------------------------------------------------------
// Search — designator search across all pages of the device.
// ---------------------------------------------------------------------------

function closeSearch() {
  el.searchPanel.classList.add('hidden');
}

function renderSearchResults() {
  const q = el.searchInput.value.trim().toLowerCase();
  const modsOnly = el.searchModsOnly.checked;
  const modDesignators = new Set(state.device.mods.map((m) => m.anchorDesignator).filter(Boolean));

  let results = state.device.annotations.filter((a) => {
    if (modsOnly && !modDesignators.has(a.designator)) return false;
    if (!q) return false;
    return a.designator.toLowerCase().includes(q);
  });
  results.sort((a, b) => a.designator.localeCompare(b.designator) || a.page - b.page);
  const shown = results.slice(0, 60);

  el.searchResults.innerHTML = shown.length === 0
    ? `<div class="sr-empty">${q || modsOnly ? 'NO MATCHES' : 'TYPE TO SEARCH'}</div>`
    : shown.map((a) => {
      const pg = state.device.meta.pages[a.page - 1];
      const hasMod = modDesignators.has(a.designator);
      return `<div class="sr-item" data-id="${esc(a.id)}" data-page="${a.page}">` +
        `<span class="ic-designator">${esc(a.designator)}</span>` +
        `<span class="pm-type">PG ${a.page} ${esc((pg && pg.type || '').toUpperCase())}</span>` +
        (hasMod ? '<span class="sr-mod-tag">MOD</span>' : '') +
        `</div>`;
    }).join('');

  el.searchResults.querySelectorAll('.sr-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const page = parseInt(item.dataset.page, 10);
      closeSearch();
      if (page === state.pageIndex + 1) {
        const a = state.device.annotations.find((x) => x.id === id);
        if (a) selectAnnotation(a, { center: true });
      } else {
        state.pendingFocus = id;
        navigate(`#/d/${state.device.slug}/p/${page}`);
      }
    });
  });
}

el.btnSearch.addEventListener('click', () => {
  el.searchPanel.classList.remove('hidden');
  el.searchInput.value = '';
  el.searchModsOnly.checked = false;
  renderSearchResults();
  el.searchInput.focus();
});
el.btnSearchClose.addEventListener('click', closeSearch);
el.searchInput.addEventListener('input', renderSearchResults);
el.searchModsOnly.addEventListener('change', renderSearchResults);

// ---------------------------------------------------------------------------
// Copy-context — plaintext block for pasting into an external Claude chat.
// ---------------------------------------------------------------------------

function buildContextText(a) {
  const d = state.device;
  const xrefs = d.annotations
    .filter((x) => x.designator === a.designator && x.id !== a.id)
    .map((x) => `PG ${x.page} ${(d.meta.pages[x.page - 1] || {}).type || ''}`.trim());
  const installedMod = d.mods.find((m) => m.anchorDesignator === a.designator && m.status === 'installed');

  const lines = [
    `DEVICE: ${d.meta.name}${d.meta.model ? ' (' + d.meta.model + ')' : ''}`,
    `PAGE: ${a.page} (${(d.meta.pages[a.page - 1] || {}).type || ''})`,
    `DESIGNATOR: ${a.designator}${a.componentType ? ' — ' + a.componentType : ''}`,
    `VALUE: ${a.value || 'unknown'} [${a.verified ? 'verified' : 'unverified'} · ${a.provenance || 'no provenance'}]`,
    a.function ? `FUNCTION: ${a.function}` : null,
    a.signalNotes ? `SIGNAL: ${a.signalNotes}` : null,
    xrefs.length ? `ALSO ON: ${xrefs.join(', ')}` : null,
    installedMod ? `INSTALLED MOD: ${installedMod.title} — ${installedMod.original || '?'} -> ${installedMod.installed || '?'}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

async function copyContext(a, btnEl) {
  const text = buildContextText(a);
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    // Bench Atlas is plain HTTP on the LAN — not a secure context, so the
    // async Clipboard API is unavailable. execCommand still works there.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) {
    btnEl.classList.add('copied');
    btnEl.textContent = 'COPIED';
    setTimeout(() => { btnEl.classList.remove('copied'); btnEl.textContent = 'COPY CONTEXT'; }, 1400);
  } else {
    alert('Copy failed — select and copy manually:\n\n' + text);
  }
}

// ---------------------------------------------------------------------------
// Mods space — separate, one-way linked from the Atlas. The Atlas never
// renders mod content; the installed-mod badge (above) is the only leak.
// ---------------------------------------------------------------------------

async function saveMods() {
  const res = await fetch(`/api/devices/${state.device.slug}/mods`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.device.mods),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Save failed: ' + (err.error || res.status));
    return false;
  }
  return true;
}

function closeModForm() {
  state.modDraft = null;
  el.modForm.classList.add('hidden');
  el.modForm.reset();
}

function openModForm(mod) {
  state.modDraft = { ...mod };
  el.modFormTitle.textContent = mod.id ? 'EDIT MOD' : 'NEW MOD';
  el.modFormAnchor.textContent = mod.anchorDesignator
    ? `ANCHORED TO ${mod.anchorDesignator} (PG ${mod.anchorPage})`
    : 'NO ANCHOR';
  el.mfTitle.value = mod.title || '';
  el.mfStatus.value = mod.status || 'planned';
  el.mfDate.value = mod.date || '';
  el.mfOriginal.value = mod.original || '';
  el.mfInstalled.value = mod.installed || '';
  el.mfReason.value = mod.reason || '';
  el.mfDelete.classList.toggle('hidden', !mod.id);
  el.modForm.classList.remove('hidden');
}

function renderModsTimeline() {
  const mods = state.device.mods.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (mods.length === 0) {
    el.modsTimeline.innerHTML = '<div class="mods-empty">NO MODS RECORDED YET</div>';
    return;
  }
  el.modsTimeline.innerHTML = mods.map((m) => {
    const anchor = m.anchorDesignator
      ? `<div class="mod-anchor" data-designator="${esc(m.anchorDesignator)}" data-page="${m.anchorPage || ''}">&#9670; ${esc(m.anchorDesignator)} — VIEW ON ATLAS</div>`
      : '';
    const swap = (m.original || m.installed)
      ? `<div class="mod-swap"><span>${esc(m.original || '—')}</span><span class="arrow">&#8594;</span><span>${esc(m.installed || '—')}</span></div>`
      : '';
    return `<div class="mod-entry" data-id="${esc(m.id)}">` +
      `<div class="mod-head"><span class="mod-title">${esc(m.title)}</span><span class="mod-status ${esc(m.status)}">${esc(m.status)}</span></div>` +
      `<div class="mod-date">${esc(m.date || '')}</div>` +
      swap +
      (m.reason ? `<div class="mod-reason">${esc(m.reason)}</div>` : '') +
      anchor +
      `</div>`;
  }).join('');

  el.modsTimeline.querySelectorAll('.mod-anchor').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const designator = a.dataset.designator;
      const page = a.dataset.page;
      if (!page) return;
      const ann = pageAnnotationFor(designator, parseInt(page, 10));
      if (ann) state.pendingFocus = ann.id;
      navigate(`#/d/${state.device.slug}/p/${page}`);
    });
  });
  el.modsTimeline.querySelectorAll('.mod-entry').forEach((entry) => {
    entry.addEventListener('click', () => {
      const mod = state.device.mods.find((m) => m.id === entry.dataset.id);
      if (mod) openModForm(mod);
    });
  });
}

function newModFromHere(a) {
  state.pendingModDraft = {
    id: null, anchorDesignator: a.designator, anchorPage: a.page,
    modDesignators: [], title: '', status: 'planned', date: '',
    original: a.value || '', installed: '', reason: '', modPages: [],
  };
  navigate(`#/d/${state.device.slug}/mods`);
}

async function showModsSpace(slug) {
  try {
    await loadDevice(slug);
  } catch (e) {
    console.error(e);
    navigate('#/');
    return;
  }

  hideAllSections();
  el.modsSpace.classList.remove('hidden');
  el.btnBack.classList.remove('hidden');
  el.deviceTabs.classList.remove('hidden');
  el.tabAtlas.classList.remove('on');
  el.tabMods.classList.add('on');
  el.tbTitle.textContent = (state.device.meta.name || slug).toUpperCase();
  el.pager.classList.add('hidden');
  el.btnInvert.classList.add('hidden');
  el.btnRegions.classList.add('hidden');
  el.btnReview.classList.add('hidden');
  el.btnSearch.classList.add('hidden');
  el.btnPath.classList.add('hidden');

  closeModForm();
  renderModsTimeline();
  if (state.pendingModDraft) {
    openModForm(state.pendingModDraft);
    state.pendingModDraft = null;
  }

  el.stDevice.textContent = state.device.slug.toUpperCase();
  el.stPage.textContent = 'MODS';
  el.stZoom.textContent = '–';
  el.stPath.textContent = '–';
  el.stRegions.textContent = `${state.device.mods.length} MODS`;
}

el.btnModNew.addEventListener('click', () => openModForm({
  id: null, anchorDesignator: null, anchorPage: null, modDesignators: [],
  title: '', status: 'planned', date: '', original: '', installed: '', reason: '', modPages: [],
}));
el.mfCancel.addEventListener('click', closeModForm);

el.modForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const draft = state.modDraft;
  const title = el.mfTitle.value.trim();
  if (!title) { alert('title is required'); return; }
  const record = {
    id: draft.id || ('mod-' + Math.random().toString(36).slice(2, 10)),
    anchorDesignator: draft.anchorDesignator || null,
    anchorPage: draft.anchorPage || null,
    modDesignators: draft.modDesignators || [],
    title,
    reason: el.mfReason.value.trim(),
    status: el.mfStatus.value,
    date: el.mfDate.value || null,
    original: el.mfOriginal.value.trim(),
    installed: el.mfInstalled.value.trim(),
    modPages: draft.modPages || [],
  };
  const idx = state.device.mods.findIndex((m) => m.id === record.id);
  if (idx >= 0) state.device.mods[idx] = record; else state.device.mods.push(record);

  const ok = await saveMods();
  if (!ok) {
    if (idx >= 0) state.device.mods[idx] = draft; else state.device.mods.pop();
    return;
  }
  closeModForm();
  renderModsTimeline();
  el.stRegions.textContent = `${state.device.mods.length} MODS`;
});

el.mfDelete.addEventListener('click', async () => {
  const draft = state.modDraft;
  if (!confirm(`Delete mod "${draft.title}"?`)) return;
  const idx = state.device.mods.findIndex((m) => m.id === draft.id);
  const removed = idx >= 0 ? state.device.mods.splice(idx, 1)[0] : null;
  const ok = await saveMods();
  if (!ok) {
    if (removed) state.device.mods.splice(idx, 0, removed);
    return;
  }
  closeModForm();
  renderModsTimeline();
  el.stRegions.textContent = `${state.device.mods.length} MODS`;
});

// ---------------------------------------------------------------------------
// Reference guide tab — the existing standalone guide, served unmodified.
// ---------------------------------------------------------------------------

function showReference(anchor) {
  hideAllSections();
  el.referenceView.classList.remove('hidden');
  el.btnBack.classList.remove('hidden');
  el.deviceTabs.classList.add('hidden');
  el.pager.classList.add('hidden');
  el.btnInvert.classList.add('hidden');
  el.btnRegions.classList.add('hidden');
  el.btnReview.classList.add('hidden');
  el.btnSearch.classList.add('hidden');
  el.btnPath.classList.add('hidden');
  el.tbTitle.textContent = 'REFERENCE GUIDE';

  const src = anchor ? `/reference#${anchor}` : '/reference';
  if (el.referenceFrame.dataset.src !== src) {
    el.referenceFrame.src = src;
    el.referenceFrame.dataset.src = src;
  }

  el.stDevice.textContent = 'REFERENCE';
  el.stPage.textContent = '–';
  el.stZoom.textContent = '–';
  el.stPath.textContent = '–';
  el.stRegions.textContent = '–';
}

// ---------------------------------------------------------------------------
// Device-space tab switching (Atlas / Mods) + the always-available Ref tab
// ---------------------------------------------------------------------------

el.tabAtlas.addEventListener('click', () => {
  if (!state.device) return;
  navigate(`#/d/${state.device.slug}/p/${state.lastAtlasPage || 1}`);
});
el.tabMods.addEventListener('click', () => {
  if (!state.device) return;
  navigate(`#/d/${state.device.slug}/mods`);
});
el.btnRef.addEventListener('click', () => navigate('#/ref'));

// ---------------------------------------------------------------------------
// Pan / zoom — pointer events; one pointer pans, two pinch, wheel zooms.
// Taps (small movement, no pinch) hit-test against regions.
// A long press (no move, no second pointer) on a region opens "new mod from
// here" directly, without requiring the info card first.
// ---------------------------------------------------------------------------

const MIN_SCALE_FACTOR = 0.25; // relative to fit
const MAX_SCALE = 8;
const TAP_SLOP_PX = 8;

let fitScale = 1;
const pointers = new Map();
let pinchStart = null; // { dist, scale, mid, tx, ty }
let gesture = null;    // { startX, startY, moved, multi }
let drawStart = null;  // { nx, ny } — origin of an in-progress rubber-band region
const LONG_PRESS_MS = 550;
let longPressTimer = null;
let longPressFired = false;

function applyView() {
  const { scale, tx, ty } = state.view;
  el.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  el.stZoom.textContent = `ZOOM ${Math.round(scale * 100)}%`;
}

function fitToView() {
  const vp = el.viewport.getBoundingClientRect();
  const { w, h } = state.imgSize;
  if (!w || !h || !vp.width || !vp.height) return;
  fitScale = Math.min(vp.width / w, vp.height / h) * 0.98;
  state.view.scale = fitScale;
  state.view.tx = (vp.width - w * fitScale) / 2;
  state.view.ty = (vp.height - h * fitScale) / 2;
  applyView();
}

function zoomAt(cx, cy, factor) {
  const v = state.view;
  const newScale = Math.min(Math.max(v.scale * factor, fitScale * MIN_SCALE_FACTOR), MAX_SCALE);
  const actual = newScale / v.scale;
  // keep the point under (cx, cy) stationary
  v.tx = cx - (cx - v.tx) * actual;
  v.ty = cy - (cy - v.ty) * actual;
  v.scale = newScale;
  applyView();
}

el.viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = el.viewport.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

el.viewport.addEventListener('pointerdown', (e) => {
  el.viewport.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { startX: e.clientX, startY: e.clientY, moved: false, multi: false };
    if (state.review && state.drawMode) {
      const { nx, ny } = clientToNorm(e.clientX, e.clientY);
      drawStart = { nx, ny };
      state.drawRect = { x: nx, y: ny, w: 0, h: 0 };
    } else if (!state.review && state.device) {
      // long-press (no move, no second pointer) → "new mod from here" directly
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (!gesture || gesture.moved || gesture.multi) return;
        const hit = hitTest(e.clientX, e.clientY);
        if (hit) {
          longPressFired = true;
          newModFromHere(hit);
        }
      }, LONG_PRESS_MS);
    }
  } else {
    if (gesture) gesture.multi = true;
    drawStart = null;
    state.drawRect = null;
    clearTimeout(longPressTimer);
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      scale: state.view.scale,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      tx: state.view.tx,
      ty: state.view.ty,
    };
  }
  el.viewport.classList.add('panning');
});

el.viewport.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture && !gesture.moved) {
    if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > TAP_SLOP_PX) {
      gesture.moved = true;
      clearTimeout(longPressTimer);
    }
  }

  if (pointers.size === 1) {
    if (drawStart) {
      const { nx, ny } = clientToNorm(e.clientX, e.clientY);
      state.drawRect = {
        x: Math.min(drawStart.nx, nx), y: Math.min(drawStart.ny, ny),
        w: Math.abs(nx - drawStart.nx), h: Math.abs(ny - drawStart.ny),
      };
      renderRegions();
    } else if (!gesture || gesture.moved) {
      state.view.tx += e.clientX - prev.x;
      state.view.ty += e.clientY - prev.y;
      applyView();
    }
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = el.viewport.getBoundingClientRect();

    const rawScale = pinchStart.scale * (dist / pinchStart.dist);
    const scale = Math.min(Math.max(rawScale, fitScale * MIN_SCALE_FACTOR), MAX_SCALE);
    const k = scale / pinchStart.scale;
    // scale about the initial midpoint, then track midpoint drift
    const mx = pinchStart.mid.x - rect.left;
    const my = pinchStart.mid.y - rect.top;
    state.view.scale = scale;
    state.view.tx = mx - (mx - pinchStart.tx) * k + (mid.x - pinchStart.mid.x);
    state.view.ty = my - (my - pinchStart.ty) * k + (mid.y - pinchStart.mid.y);
    applyView();
  }
});

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

function finishDraw() {
  const r = state.drawRect;
  state.drawRect = null;
  state.drawMode = false;
  el.btnDraw.classList.remove('on');
  el.viewport.classList.remove('drawing');
  if (!r) { renderRegions(); return; }

  // The drag can start/end outside the image (the page is letterboxed at
  // fit zoom) — clamp to [0,1] so the bbox is always a valid normalized rect.
  const x = clamp01(r.x), y = clamp01(r.y);
  const w = clamp01(r.x + r.w) - x;
  const h = clamp01(r.y + r.h) - y;
  if (w < 0.005 || h < 0.005) { renderRegions(); return; } // too small, ignore

  const newAnnotation = {
    id: 'user-' + Math.random().toString(36).slice(2, 10),
    page: state.pageIndex + 1,
    pageType: (currentPage().type) || 'other',
    bbox: { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) },
    designator: '', componentType: '', value: null, valueSource: null,
    function: null, signalNotes: null, datasheet: null,
    confidence: 1, provenance: 'verified', verified: true, flags: [],
  };
  openEditCard(newAnnotation, { isNew: true });
}

function endPointer(e) {
  const wasTap = gesture && !gesture.moved && !gesture.multi &&
    pointers.size === 1 && pointers.has(e.pointerId);
  const wasDraw = drawStart && pointers.size === 1 && pointers.has(e.pointerId);
  clearTimeout(longPressTimer);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    el.viewport.classList.remove('panning');
    if (longPressFired) {
      // already handled ("new mod from here"); don't also fire the tap
    } else if (wasDraw && e.type === 'pointerup') {
      finishDraw();
    } else if (wasTap && e.type === 'pointerup' && state.device) {
      const hit = hitTest(e.clientX, e.clientY);
      if (state.review) {
        if (hit) openEditCard(hit, { isNew: false });
        else cancelEdit();
      } else if (hit) {
        selectAnnotation(hit);
      } else {
        clearSelection();
        renderRegions();
      }
    }
    gesture = null;
    drawStart = null;
    longPressFired = false;
  }
}
el.viewport.addEventListener('pointerup', endPointer);
el.viewport.addEventListener('pointercancel', endPointer);

el.viewport.addEventListener('dblclick', (e) => {
  const rect = el.viewport.getBoundingClientRect();
  const atFit = Math.abs(state.view.scale - fitScale) < 0.01;
  if (atFit) zoomAt(e.clientX - rect.left, e.clientY - rect.top, 2.5);
  else fitToView();
});

window.addEventListener('resize', () => {
  if (state.device) fitToView();
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

el.btnBack.addEventListener('click', () => navigate('#/'));
el.btnPrev.addEventListener('click', () => gotoPage(-1));
el.btnNext.addEventListener('click', () => gotoPage(1));
el.btnPageList.addEventListener('click', () => el.pageMenu.classList.toggle('hidden'));

el.btnInvert.addEventListener('click', async () => {
  state.invert = !state.invert;
  el.btnInvert.classList.toggle('on', state.invert);
  await loadPageImage(false); // keep current pan/zoom
});

el.btnRegions.addEventListener('click', () => {
  state.showRegions = !state.showRegions;
  el.btnRegions.classList.toggle('on', state.showRegions);
  renderRegions();
});

el.btnReview.addEventListener('click', () => {
  state.review = !state.review;
  el.btnReview.classList.toggle('on', state.review);
  el.reviewBar.classList.toggle('hidden', !state.review);
  if (state.review) {
    // unverified/flagged items must be visually prominent in review mode
    state.showRegions = true;
    el.btnRegions.classList.add('on');
  } else {
    state.drawMode = false;
    el.btnDraw.classList.remove('on');
    el.viewport.classList.remove('drawing');
    el.queuePanel.classList.add('hidden');
    cancelEdit();
  }
  renderRegions();
});

el.btnDraw.addEventListener('click', () => {
  state.drawMode = !state.drawMode;
  el.btnDraw.classList.toggle('on', state.drawMode);
  el.viewport.classList.toggle('drawing', state.drawMode);
});

el.btnQueue.addEventListener('click', () => {
  const willShow = el.queuePanel.classList.contains('hidden');
  if (willShow) renderQueue();
  el.queuePanel.classList.toggle('hidden', !willShow);
});

function openAddPage() {
  el.addpagePanel.reset();
  el.addpagePanel.classList.remove('hidden');
}

el.btnAddPage.addEventListener('click', openAddPage);
el.btnAddPageEmpty.addEventListener('click', openAddPage);
el.apCancel.addEventListener('click', () => {
  el.addpagePanel.classList.add('hidden');
  el.addpagePanel.reset();
});

el.addpagePanel.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = el.apFile.files[0];
  if (!file) return;
  const type = el.apType.value;
  const title = el.apTitle.value.trim();
  const buf = await file.arrayBuffer();
  const qs = new URLSearchParams({ type, title });
  const res = await fetch(`/api/devices/${state.device.slug}/pages?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'image/png' },
    body: buf,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Upload failed: ' + (err.error || res.status));
    return;
  }
  const data = await res.json();
  state.device.meta = data.meta;
  el.addpagePanel.classList.add('hidden');
  el.addpagePanel.reset();
  navigate(`#/d/${state.device.slug}/p/${data.page}`);
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function updateStatus() {
  const p = currentPage();
  el.stDevice.textContent = state.device.slug.toUpperCase();
  el.stPage.textContent = `PG ${state.pageIndex + 1}/${state.device.meta.pages.length} ${(p.type || '').toUpperCase()}`;
  el.stPath.textContent = state.activePath
    ? `PATH ${state.activeStep + 1}/${state.activePath.steps.length} ${state.activePath.name.toUpperCase()}`
    : 'NO PATH';
  el.stRegions.textContent = `${pageAnnotations().length} RGN`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  try {
    await loadDevices();
  } catch (e) {
    console.error(e);
  }
  route();
})();

// exposed for dev tooling / tests
window.atlas = { state, hitTest, selectAnnotation, clientToNorm };
