#!/usr/bin/env node
// Bench Atlas — batch indexer CLI.
// Staged, resumable, checkpointed per page: a crash resumes, never restarts.
//
//   node atlas/indexer/index.js devices/<slug> <manual.pdf> [--dry-run]
//
// This is the ONLY place in the project that talks to the Claude API — the
// server and viewer are fully offline at runtime.

'use strict';

const fs = require('fs');
const path = require('path');
const { loadCheckpoint, saveCheckpoint } = require('./lib/checkpoint');
const { runIngest, pdfPageCount } = require('./lib/ingest');
const { checkIngestTools } = require('./lib/tools');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && !process.env[m[1]]) {
      process.env[m[1]] = m[2];
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('usage: node atlas/indexer/index.js devices/<slug> <manual.pdf> [--dry-run]');
    process.exit(1);
  }
  return { deviceDir: positional[0], pdfPath: path.resolve(positional[1]), dryRun };
}

function main() {
  loadEnv();
  const { deviceDir, pdfPath, dryRun } = parseArgs(process.argv);

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`manual PDF not found: ${pdfPath}`);
  }

  if (dryRun) {
    checkIngestTools();
    const pages = pdfPageCount(pdfPath);
    console.log(`DRY RUN — ${path.basename(pdfPath)}`);
    console.log(`  pages: ${pages}`);
    console.log(`  stage 1 (ingest): ${pages} pdftoppm renders + ${pages} imagemagick negates, no API calls`);
    console.log(`  stages 2+ (classification, parts-list, region detection, enrichment) are not yet implemented in this build`);
    console.log('  re-run without --dry-run to ingest.');
    return;
  }

  const absDeviceDir = path.resolve(deviceDir);
  const pagesDir = path.join(absDeviceDir, 'pages');
  const workDir = path.join(absDeviceDir, 'index-work');
  const rawDir = path.join(workDir, 'raw'); // raw API responses per page, for audit
  fs.mkdirSync(absDeviceDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const checkpoint = loadCheckpoint(workDir) || { pdf: pdfPath, pageCount: null, ingest: null };
  const save = () => saveCheckpoint(workDir, checkpoint);

  console.log(`Ingesting ${path.basename(pdfPath)} -> ${path.relative(REPO_ROOT, pagesDir)}`);
  const pages = runIngest(pdfPath, pagesDir, checkpoint, save);
  console.log(`Stage 1 (ingest) complete: ${pages.length} pages rendered at 300 DPI, with inverted copies.`);
  console.log('Stage 2 (classification + human gate) is not yet implemented — nothing further to do.');
}

main();
