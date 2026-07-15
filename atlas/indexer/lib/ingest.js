// Stage 1 — Ingest: PDF -> PNG at 300+ DPI, plus an inverted copy of every
// page. Classification (stage 2) later decides which pages are line art and
// therefore get the inverted copy referenced from meta.json — inverting here
// unconditionally is cheap and keeps stage 1 fully independent of stage 2.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkIngestTools } = require('./tools');
const { pngDimensions } = require('./pngmeta');

const DPI = 300;

function pdfPageCount(pdfPath) {
  const res = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`unreadable PDF (pdfinfo failed): ${pdfPath}\n${res.stderr || ''}`);
  }
  const m = res.stdout.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error(`could not determine page count for ${pdfPath}`);
  return parseInt(m[1], 10);
}

function padNum(n) {
  return String(n).padStart(2, '0');
}

// Runs (or resumes) stage 1. Returns the list of page records:
// [{ page, file, inv, width, height }]
function runIngest(pdfPath, pagesDir, checkpoint, save) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  checkIngestTools();

  const pageCount = pdfPageCount(pdfPath);
  checkpoint.pageCount = checkpoint.pageCount || pageCount;
  checkpoint.ingest = checkpoint.ingest || { done: false, pages: {} };

  fs.mkdirSync(pagesDir, { recursive: true });

  for (let n = 1; n <= pageCount; n++) {
    if (checkpoint.ingest.pages[n]) continue; // already ingested — resume skips it

    const file = `page-${padNum(n)}.png`;
    const invFile = `page-${padNum(n)}-inv.png`;
    const outPrefix = path.join(pagesDir, `.raw-${n}`);

    const render = spawnSync('pdftoppm', [
      '-png', '-r', String(DPI),
      '-f', String(n), '-l', String(n),
      pdfPath, outPrefix,
    ], { encoding: 'utf8' });
    if (render.status !== 0) {
      throw new Error(`pdftoppm failed on page ${n}: ${render.stderr || render.error}`);
    }

    // poppler names single-page output "<prefix>.png" when -f == -l, or
    // "<prefix>-N.png" depending on version — handle both.
    const candidates = [`${outPrefix}.png`, `${outPrefix}-${n}.png`, `${outPrefix}-${padNum(n)}.png`];
    const rendered = candidates.find((c) => fs.existsSync(c));
    if (!rendered) throw new Error(`pdftoppm did not produce expected output for page ${n}`);

    fs.renameSync(rendered, path.join(pagesDir, file));

    const negate = spawnSync('convert', [
      path.join(pagesDir, file), '-negate', path.join(pagesDir, invFile),
    ], { encoding: 'utf8' });
    if (negate.status !== 0) {
      throw new Error(`imagemagick negate failed on page ${n}: ${negate.stderr || negate.error}`);
    }

    const { width, height } = pngDimensions(path.join(pagesDir, file));
    checkpoint.ingest.pages[n] = { page: n, file, inv: invFile, width, height };
    save();
  }

  checkpoint.ingest.done = true;
  save();

  return Object.values(checkpoint.ingest.pages).sort((a, b) => a.page - b.page);
}

module.exports = { runIngest, pdfPageCount };
