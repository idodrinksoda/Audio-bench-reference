#!/usr/bin/env node
// Bench Atlas — fixture device generator (dev only).
// Generates devices/fixture-amp/ from scratch: fake schematic / PCB / photo
// pages (plus index-time inverted copies) and hand-authored JSON.
// Dependency-free: PNG encoding via built-in zlib + hand-rolled CRC32.
//
// The page drawings and annotations.json are emitted from the SAME component
// tables below, so fixture bboxes always align with the drawn symbols.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'devices', 'fixture-amp');

// ---------------------------------------------------------------------------
// Minimal grayscale PNG encoder
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Drawing canvas
// ---------------------------------------------------------------------------

// 5x7 column-major font (bit 0 = top row), classic LED-matrix glyphs.
const FONT = {
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e], '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10], '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30], '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  ' ': [0, 0, 0, 0, 0], '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '.': [0x00, 0x60, 0x60, 0x00, 0x00], ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  '/': [0x20, 0x10, 0x08, 0x04, 0x02], '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
};

class Canvas {
  constructor(w, h, bg = 255) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h).fill(bg);
  }
  set(x, y, v) {
    x |= 0; y |= 0;
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.px[y * this.w + x] = v;
  }
  fillRect(x, y, w, h, v) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, v);
  }
  strokeRect(x, y, w, h, t, v) {
    this.fillRect(x, y, w, t, v);
    this.fillRect(x, y + h - t, w, t, v);
    this.fillRect(x, y, t, h, v);
    this.fillRect(x + w - t, y, t, h, v);
  }
  line(x0, y0, x1, y1, t, v) {
    // Bresenham with square pen of size t
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
    const o = Math.floor(t / 2);
    for (;;) {
      this.fillRect(x0 - o, y0 - o, t, t, v);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  circle(cx, cy, r, t, v) {
    const steps = Math.max(24, Math.floor(r * 2));
    const o = Math.floor(t / 2);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      this.fillRect(Math.round(cx + r * Math.cos(a)) - o, Math.round(cy + r * Math.sin(a)) - o, t, t, v);
    }
  }
  fillCircle(cx, cy, r, v) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) this.set(cx + x, cy + y, v);
    }
  }
  text(x, y, str, scale, v) {
    let cx = x;
    for (const ch of String(str).toUpperCase()) {
      const glyph = FONT[ch] || FONT[' '];
      for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 7; row++) {
          if (glyph[col] & (1 << row)) this.fillRect(cx + col * scale, y + row * scale, scale, scale, v);
        }
      }
      cx += 6 * scale;
    }
    return cx - x; // rendered width
  }
  inverted() {
    const c = new Canvas(this.w, this.h);
    for (let i = 0; i < this.px.length; i++) c.px[i] = 255 - this.px[i];
    return c;
  }
  save(file) {
    fs.writeFileSync(file, encodePNG(this.w, this.h, this.px));
  }
}

// ---------------------------------------------------------------------------
// Component tables — single source of truth for drawings AND annotations.
// Pixel coords on a 1275x1650 page; bboxes normalized at emit time.
// ---------------------------------------------------------------------------

const W = 1275, H = 1650;

// Schematic (page 1) symbol anchor points
const SCH = {
  J101: { x: 140, y: 480 },
  VR101: { x: 330, y: 480 },
  C101: { x: 540, y: 480 },
  R101: { x: 720, y: 480 },
  Q101: { x: 930, y: 480 },
  R102: { x: 930, y: 700 },
  U101: { x: 560, y: 950 },
  C102: { x: 850, y: 950 },
  J102: { x: 1060, y: 950 },
};

// PCB layout (page 2) footprint anchor points
const PCB = {
  J101: { x: 250, y: 400 },
  VR101: { x: 420, y: 400 },
  C101: { x: 590, y: 400 },
  R101: { x: 760, y: 400 },
  Q101: { x: 930, y: 400 },
  R102: { x: 930, y: 620 },
  U101: { x: 560, y: 850 },
  C102: { x: 780, y: 850 },
  J102: { x: 980, y: 850 },
};

// Photo (page 3) — simulated board photo, same designators, no labels legible
const PHOTO = {
  C101: { x: 500, y: 500 },
  Q101: { x: 800, y: 480 },
  U101: { x: 620, y: 800 },
};

const INK = 0;
const T = 3; // line thickness

// ---------------------------------------------------------------------------
// Page 1 — schematic
// ---------------------------------------------------------------------------

function drawResistor(c, x, y, label) {
  // zigzag horizontal resistor centered on (x, y)
  const seg = 12, amp = 16;
  c.line(x - 60, y, x - 42, y, T, INK);
  let px = x - 42, py = y;
  for (let i = 0; i < 6; i++) {
    const nx = px + seg;
    const ny = y + (i % 2 === 0 ? -amp : amp);
    c.line(px, py, nx, ny, T, INK);
    px = nx; py = ny;
  }
  c.line(px, py, x + 42, y, T, INK);
  c.line(x + 42, y, x + 60, y, T, INK);
  c.text(x - 30, y - 52, label, 3, INK);
}

function drawCap(c, x, y, label) {
  c.line(x - 60, y, x - 8, y, T, INK);
  c.line(x - 8, y - 24, x - 8, y + 24, T + 1, INK);
  c.line(x + 8, y - 24, x + 8, y + 24, T + 1, INK);
  c.line(x + 8, y, x + 60, y, T, INK);
  c.text(x - 30, y - 60, label, 3, INK);
}

function drawTransistor(c, x, y, label) {
  c.circle(x, y, 42, T, INK);
  c.line(x - 60, y, x - 14, y, T, INK);           // base lead
  c.line(x - 14, y - 26, x - 14, y + 26, T, INK); // base bar
  c.line(x - 14, y - 12, x + 22, y - 34, T, INK); // collector
  c.line(x + 22, y - 34, x + 22, y - 60, T, INK);
  c.line(x - 14, y + 12, x + 22, y + 34, T, INK); // emitter
  c.line(x + 22, y + 34, x + 22, y + 60, T, INK);
  c.text(x + 52, y - 10, label, 3, INK);
}

function drawPot(c, x, y, label) {
  drawResistor(c, x, y, '');
  c.line(x, y - 46, x, y - 20, T, INK);           // wiper arrow
  c.line(x - 8, y - 34, x, y - 20, T, INK);
  c.line(x + 8, y - 34, x, y - 20, T, INK);
  c.text(x - 40, y - 78, label, 3, INK);
}

function drawIC(c, x, y, label, sub) {
  c.strokeRect(x - 70, y - 50, 140, 100, T, INK);
  c.text(x - 55, y - 30, label, 3, INK);
  if (sub) c.text(x - 55, y + 6, sub, 2, INK);
  for (let i = 0; i < 4; i++) {
    c.line(x - 70 - 24, y - 36 + i * 24, x - 70, y - 36 + i * 24, T, INK);
    c.line(x + 70, y - 36 + i * 24, x + 70 + 24, y - 36 + i * 24, T, INK);
  }
}

function drawJack(c, x, y, label) {
  c.circle(x, y, 22, T, INK);
  c.fillCircle(x, y, 5, INK);
  c.line(x + 22, y, x + 60, y, T, INK);
  c.text(x - 35, y - 60, label, 3, INK);
}

function buildSchematic() {
  const c = new Canvas(W, H);
  c.strokeRect(20, 20, W - 40, H - 40, 2, INK);

  // title block, bottom right
  c.strokeRect(W - 480, H - 140, 460, 120, 2, INK);
  c.text(W - 460, H - 120, 'FIXTURE AMP FX-100', 3, INK);
  c.text(W - 460, H - 84, 'SCHEMATIC DIAGRAM', 2, INK);
  c.text(W - 460, H - 56, 'SHEET 1/1', 2, INK);

  drawJack(c, SCH.J101.x, SCH.J101.y, 'J101');
  drawPot(c, SCH.VR101.x, SCH.VR101.y, 'VR101');
  drawCap(c, SCH.C101.x, SCH.C101.y, 'C101');
  drawResistor(c, SCH.R101.x, SCH.R101.y, 'R101');
  drawTransistor(c, SCH.Q101.x, SCH.Q101.y, 'Q101');
  drawResistor(c, SCH.R102.x, SCH.R102.y, 'R102');
  drawIC(c, SCH.U101.x, SCH.U101.y, 'U101', 'LM386');
  drawCap(c, SCH.C102.x, SCH.C102.y, 'C102');
  drawJack(c, SCH.J102.x, SCH.J102.y, 'J102');

  // signal wiring left→right
  c.line(SCH.J101.x + 60, SCH.J101.y, SCH.VR101.x - 60, SCH.VR101.y, T, INK);
  c.line(SCH.VR101.x + 60, SCH.VR101.y, SCH.C101.x - 60, SCH.C101.y, T, INK);
  c.line(SCH.C101.x + 60, SCH.C101.y, SCH.R101.x - 60, SCH.R101.y, T, INK);
  c.line(SCH.R101.x + 60, SCH.R101.y, SCH.Q101.x - 60, SCH.Q101.y, T, INK);
  c.line(SCH.Q101.x + 22, SCH.Q101.y + 60, SCH.R102.x + 22, SCH.R102.y - 60, T, INK); // emitter down
  c.line(SCH.Q101.x + 22, SCH.Q101.y + 60, SCH.U101.x - 94, SCH.U101.y - 12, T, INK); // into IC
  c.line(SCH.U101.x + 94, SCH.U101.y, SCH.C102.x - 60, SCH.C102.y, T, INK);
  c.line(SCH.C102.x + 60, SCH.C102.y, SCH.J102.x - 22, SCH.J102.y, T, INK);

  return c;
}

// ---------------------------------------------------------------------------
// Page 2 — PCB layout
// ---------------------------------------------------------------------------

function buildPCB() {
  const c = new Canvas(W, H);
  c.strokeRect(20, 20, W - 40, H - 40, 2, INK);
  c.text(60, 60, 'FIXTURE AMP FX-100 - PCB LAYOUT - MAIN BOARD TOP', 3, INK);

  // board outline
  c.strokeRect(120, 200, 1020, 900, 4, INK);
  // mounting holes
  for (const [hx, hy] of [[170, 250], [1090, 250], [170, 1050], [1090, 1050]]) {
    c.circle(hx, hy, 16, 3, INK);
  }

  const pad = (x, y) => { c.circle(x, y, 10, 3, INK); c.fillCircle(x, y, 3, INK); };

  for (const [ref, p] of Object.entries(PCB)) {
    if (ref === 'U101') {
      c.strokeRect(p.x - 60, p.y - 40, 120, 80, T, INK);
      for (let i = 0; i < 4; i++) { pad(p.x - 75, p.y - 30 + i * 20); pad(p.x + 75, p.y - 30 + i * 20); }
      c.text(p.x - 40, p.y - 70, ref, 3, INK);
    } else if (ref.startsWith('Q')) {
      c.circle(p.x, p.y, 30, T, INK);
      pad(p.x - 14, p.y + 10); pad(p.x, p.y - 14); pad(p.x + 14, p.y + 10);
      c.text(p.x - 35, p.y - 66, ref, 3, INK);
    } else if (ref.startsWith('J')) {
      c.strokeRect(p.x - 35, p.y - 25, 70, 50, T, INK);
      pad(p.x, p.y);
      c.text(p.x - 35, p.y - 60, ref, 3, INK);
    } else {
      // two-lead footprint
      c.strokeRect(p.x - 40, p.y - 16, 80, 32, T, INK);
      pad(p.x - 52, p.y); pad(p.x + 52, p.y);
      c.text(p.x - 40, p.y - 52, ref, 3, INK);
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Page 3 — simulated unit photo (grayscale, never inverted)
// ---------------------------------------------------------------------------

function buildPhoto() {
  const c = new Canvas(W, H, 96); // dark bench background
  // board
  c.fillRect(150, 250, 980, 900, 60);
  c.strokeRect(150, 250, 980, 900, 6, 40);
  // traces (lighter lines)
  for (let i = 0; i < 8; i++) {
    c.line(200 + i * 40, 300, 350 + i * 90, 1100, 4, 84);
  }
  // components as light blobs (no legible designators — that's the point)
  const p = PHOTO;
  c.fillRect(p.C101.x - 30, p.C101.y - 55, 60, 110, 170);   // electrolytic can
  c.fillCircle(p.C101.x, p.C101.y - 55, 30, 190);
  c.fillCircle(p.Q101.x, p.Q101.y, 36, 30);                 // TO-92 body
  c.fillRect(p.Q101.x - 36, p.Q101.y, 72, 36, 30);
  c.fillRect(p.U101.x - 70, p.U101.y - 35, 140, 70, 25);    // DIP-8
  for (let i = 0; i < 4; i++) {
    c.fillRect(p.U101.x - 60 + i * 36, p.U101.y - 45, 8, 10, 200);
    c.fillRect(p.U101.x - 60 + i * 36, p.U101.y + 35, 8, 10, 200);
  }
  c.text(180, 1200, 'UNIT PHOTO - MAIN BOARD', 3, 200);
  return c;
}

// ---------------------------------------------------------------------------
// Annotations — emitted from the same tables; bboxes normalized 0-1.
// ---------------------------------------------------------------------------

function bbox(p, hw, hh) {
  // half-width/half-height in px around anchor → normalized bbox
  return {
    x: +((p.x - hw) / W).toFixed(4),
    y: +((p.y - hh) / H).toFixed(4),
    w: +((2 * hw) / W).toFixed(4),
    h: +((2 * hh) / H).toFixed(4),
  };
}

function makeAnnotations() {
  const a = [];
  const add = (id, page, pageType, box, fields) =>
    a.push({
      id, page, pageType, bbox: box,
      value: null, valueSource: null, function: null, signalNotes: null,
      datasheet: null, confidence: 1, provenance: 'verified', verified: true,
      flags: [], ...fields,
    });

  // --- Page 1: schematic ---
  add('fx-j101-sch', 1, 'schematic', bbox(SCH.J101, 70, 75), {
    designator: 'J101', componentType: 'jack',
    value: '6.3MM MONO', valueSource: 'partslist',
    function: 'Signal input jack', signalNotes: 'expect source-level signal here',
    provenance: 'partslist', confidence: 0.95, verified: false,
  });
  add('fx-vr101-sch', 1, 'schematic', bbox(SCH.VR101, 75, 90), {
    designator: 'VR101', componentType: 'potentiometer',
    value: '10K AUDIO TAPER', valueSource: 'partslist',
    function: 'Input level control', signalNotes: 'signal on wiper follows knob position',
    provenance: 'verified', confidence: 1, verified: true,
  });
  add('fx-c101-sch', 1, 'schematic', bbox(SCH.C101, 70, 75), {
    designator: 'C101', componentType: 'capacitor',
    value: '10UF 25V', valueSource: 'partslist',
    function: 'Input coupling cap', signalNotes: 'blocks DC; AC signal on both sides',
    provenance: 'partslist', confidence: 0.9, verified: false,
  });
  add('fx-r101-sch', 1, 'schematic', bbox(SCH.R101, 70, 65), {
    designator: 'R101', componentType: 'resistor',
    value: '10K', valueSource: 'partslist',
    function: 'Base current limit for Q101',
    provenance: 'partslist', confidence: 0.9, verified: false,
  });
  add('fx-q101-sch', 1, 'schematic', bbox(SCH.Q101, 90, 75), {
    designator: 'Q101', componentType: 'transistor',
    value: '2N3904', valueSource: 'partslist',
    function: 'Input buffer, emitter follower', signalNotes: 'emitter ~0.6V below base',
    datasheet: { partNumber: '2N3904', url: null, pinout: 'TO-92: 1=E 2=B 3=C (flat side)', keySpecs: 'NPN 40V 200mA' },
    provenance: 'partslist', confidence: 0.9, verified: false,
  });
  // deliberately messy one: value not in parts list, not legible → null + flag
  add('fx-r102-sch', 1, 'schematic', bbox(SCH.R102, 70, 65), {
    designator: 'R102', componentType: 'resistor',
    value: null, valueSource: null,
    function: 'Emitter load (assumed)',
    provenance: 'vision', confidence: 0.45, verified: false,
    flags: ['not-in-partslist'],
  });
  add('fx-u101-sch', 1, 'schematic', bbox(SCH.U101, 100, 65), {
    designator: 'U101', componentType: 'ic',
    value: 'LM386N-1', valueSource: 'partslist',
    function: 'Power amp, gain 20', signalNotes: 'pin 3 in, pin 5 out; ~half supply DC on pin 5',
    datasheet: { partNumber: 'LM386', url: null, pinout: '1 GAIN 2 -IN 3 +IN 4 GND 5 OUT 6 VS 7 BYP 8 GAIN', keySpecs: '4-12V, 0.5W into 8 ohm' },
    provenance: 'datasheet', confidence: 0.85, verified: false,
  });
  add('fx-c102-sch', 1, 'schematic', bbox(SCH.C102, 70, 80), {
    designator: 'C102', componentType: 'capacitor',
    value: '220UF 16V', valueSource: 'partslist',
    function: 'Output coupling cap',
    provenance: 'partslist', confidence: 0.9, verified: false,
  });
  add('fx-j102-sch', 1, 'schematic', bbox(SCH.J102, 60, 75), {
    designator: 'J102', componentType: 'jack',
    value: '6.3MM MONO', valueSource: 'partslist',
    function: 'Speaker/output jack',
    provenance: 'partslist', confidence: 0.95, verified: false,
  });

  // --- Page 2: PCB layout ---
  const pcbSize = { J101: [45, 65], VR101: [50, 60], C101: [65, 60], R101: [65, 60], Q101: [40, 70], R102: [65, 60], U101: [90, 80], C102: [65, 60], J102: [45, 65] };
  for (const [ref, p] of Object.entries(PCB)) {
    const [hw, hh] = pcbSize[ref];
    a.push({
      id: `fx-${ref.toLowerCase()}-pcb`, page: 2, pageType: 'pcb',
      bbox: bbox(p, hw, hh), designator: ref, componentType: null,
      value: null, valueSource: null, function: null, signalNotes: null, datasheet: null,
      confidence: 0.8, provenance: 'vision', verified: ref === 'VR101',
      flags: [],
    });
  }

  // --- Page 3: photo (three-way link demo: schematic ↔ pcb ↔ photo) ---
  add('fx-c101-photo', 3, 'photo', bbox(PHOTO.C101, 45, 100), {
    designator: 'C101', componentType: 'capacitor',
    provenance: 'vision', confidence: 0.7, verified: false,
  });
  add('fx-q101-photo', 3, 'photo', bbox(PHOTO.Q101, 50, 55), {
    designator: 'Q101', componentType: 'transistor',
    provenance: 'vision', confidence: 0.7, verified: false,
  });
  add('fx-u101-photo', 3, 'photo', bbox(PHOTO.U101, 85, 60), {
    designator: 'U101', componentType: 'ic',
    provenance: 'verified', confidence: 1, verified: true,
  });

  return a;
}

function makePaths() {
  return [
    {
      id: 'fx-path-input',
      name: 'Input to speaker path',
      steps: [
        { designator: 'J101', page: 1, expectedLevel: '-20 dBV line in', note: 'input jack' },
        { designator: 'VR101', page: 1, expectedLevel: 'follows level pot', note: 'check wiper' },
        { designator: 'C101', page: 1, expectedLevel: 'same as wiper', note: 'coupling' },
        { designator: 'Q101', page: 1, expectedLevel: 'unity, buffered', note: 'emitter follower' },
        { designator: 'U101', page: 1, expectedLevel: '+26 dB vs pin 3', note: 'power amp' },
        { designator: 'C102', page: 1, expectedLevel: 'speaker level', note: 'output coupling' },
        { designator: 'J102', page: 1, expectedLevel: 'speaker level', note: 'output jack' },
      ],
      source: 'ai-proposed',
      verified: false,
    },
    {
      // deliberately spans schematic -> PCB layout, to exercise the
      // page-edge-arrow / multi-page continuation in isolation mode
      id: 'fx-path-cross-page',
      name: 'Trace to PCB (cross-sheet)',
      steps: [
        { designator: 'J101', page: 1, expectedLevel: '-20 dBV line in', note: 'schematic: input jack' },
        { designator: 'VR101', page: 1, expectedLevel: 'follows level pot', note: 'schematic: level control' },
        { designator: 'C101', page: 2, expectedLevel: 'same as wiper', note: 'now on the PCB layout' },
        { designator: 'U101', page: 2, expectedLevel: '+26 dB vs pin 3', note: 'power amp footprint' },
      ],
      source: 'user',
      verified: true,
    },
  ];
}

function makeMods() {
  return [
    {
      id: 'fx-mod-recap',
      anchorDesignator: 'C102',
      anchorPage: 1,
      modDesignators: ['M1'],
      title: 'Output cap upgrade',
      reason: 'Stock 220uF was dried out; more bass with 470uF',
      status: 'installed',
      date: '2026-07-01',
      original: '220UF 16V stock',
      installed: '470UF 25V Nichicon',
      modPages: [],
    },
  ];
}

function makeMeta() {
  return {
    name: 'Fixture Amp',
    model: 'FX-100',
    notes: 'Generated test fixture — regenerate with node atlas/fixtures/make-fixtures.js',
    pages: [
      { file: 'page-01.png', inv: 'page-01-inv.png', type: 'schematic', title: 'Main schematic' },
      { file: 'page-02.png', inv: 'page-02-inv.png', type: 'pcb', title: 'PCB layout, main board' },
      { file: 'page-03.png', inv: null, type: 'photo', title: 'Unit photo, main board' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

const pagesDir = path.join(OUT_DIR, 'pages');
fs.mkdirSync(pagesDir, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'photos'), { recursive: true });

const sch = buildSchematic();
const pcb = buildPCB();
const photo = buildPhoto();

sch.save(path.join(pagesDir, 'page-01.png'));
sch.inverted().save(path.join(pagesDir, 'page-01-inv.png'));
pcb.save(path.join(pagesDir, 'page-02.png'));
pcb.inverted().save(path.join(pagesDir, 'page-02-inv.png'));
photo.save(path.join(pagesDir, 'page-03.png')); // photos never get inverted copies

writeJSON(path.join(OUT_DIR, 'meta.json'), makeMeta());
writeJSON(path.join(OUT_DIR, 'annotations.json'), makeAnnotations());
writeJSON(path.join(OUT_DIR, 'paths.json'), makePaths());
writeJSON(path.join(OUT_DIR, 'mods.json'), makeMods());

console.log('fixture device written to', path.relative(REPO_ROOT, OUT_DIR));
for (const f of fs.readdirSync(pagesDir)) {
  const s = fs.statSync(path.join(pagesDir, f));
  console.log(`  pages/${f}  ${(s.size / 1024).toFixed(1)} KB`);
}
