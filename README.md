# Bench Atlas

A local-first interactive knowledge base for vintage audio repair. Document a
device once (service manual PDF, schematics, photos of your actual unit); an
offline AI indexer parses it once; after that the app is a fully offline visual
atlas of that device. The Claude API is used **only** by the batch indexer —
there is no live AI at runtime.

This repo also contains the standalone **Audio Bench Reference** guide
(`audio_bench_reference.html`, deployed via GitHub Pages), which the atlas
serves unmodified as a sibling tab at `/reference`.

## Requirements

- Node.js 18+ (no npm dependencies for the server/viewer — nothing to install)
- An Anthropic API key — **only** if you run the indexer
- To run the indexer: [poppler](https://poppler.freedesktop.org/) (`pdftoppm`, `pdfinfo`) and
  [ImageMagick](https://imagemagick.org/) (`convert`) on `PATH` —
  macOS: `brew install poppler imagemagick` · Debian/Ubuntu: `sudo apt install poppler-utils imagemagick`

## Setup from a clean clone

```sh
git clone <this-repo>
cd Audio-bench-reference

# 1. Config (all paths relative to repo root; no absolute paths anywhere)
cp .env.example .env
# edit .env if you want a different port; ANTHROPIC_API_KEY only needed for indexing

# 2. (dev only) generate the fixture test device
node atlas/fixtures/make-fixtures.js

# 3. Run the server
node atlas/server.js
```

The server binds `0.0.0.0` and prints its LAN URL on startup — open that URL
from your phone on the same network. No auth, no HTTPS: LAN only by design.

## Layout

```
audio_bench_reference.html   existing reference guide (untouched, served at /reference)
atlas/
  server.js                  single-file local server (static + JSON API)
  viewer/                    static SPA — vanilla JS, no build step
  indexer/                   batch indexing pipeline (CLI, the only piece that calls the Claude API)
    index.js                 CLI entry — staged, resumable, checkpointed per page
    lib/ingest.js            Stage 1: PDF -> PNG (300dpi) + inverted copies
    lib/checkpoint.js        atomic checkpoint read/write (crash resumes, never restarts)
    lib/tools.js             fail-fast checks for pdftoppm/convert on PATH
  fixtures/make-fixtures.js  generates the fixture-amp test device
devices/<slug>/              one folder per device, fully self-contained/portable
  meta.json                  name, model, page manifest
  annotations.json           the stock index (Atlas data)
  mods.json                  modification records (separate by design)
  paths.json                 named signal paths
  pages/                     page-NN.png + page-NN-inv.png   (gitignored)
  photos/                    photos of your unit             (gitignored)
  index-work/                indexer checkpoint + raw API response logs (gitignored)
partsdb/                     shared datasheet cache keyed by part number
```

### Running the indexer

```sh
# Estimate cost/scope first — no API calls, no files written
node atlas/indexer/index.js devices/my-device manual.pdf --dry-run

# Ingest: render every page at 300 DPI + an inverted copy of each
node atlas/indexer/index.js devices/my-device manual.pdf
```

Only Stage 1 (ingest) is implemented so far — classification, parts-list
extraction, region detection, and enrichment are still to come. If the
process is killed mid-run, re-running the same command resumes from
`devices/<slug>/index-work/checkpoint.json` instead of restarting.

**Git policy:** code and all device JSON are tracked (annotations/mods/paths
are irreplaceable hand-verified work). Page images and photos are gitignored —
they are regenerable from source PDFs. The `fixture-amp` device is fully
generated, so it is ignored wholesale.

## Data conventions

- Region coordinates are normalized 0–1 relative to page dimensions.
- `designator` is the join key: the same designator across schematic, PCB
  layout, and unit-photo pages is cross-linked automatically.
- Provenance tiers: `verified > partslist > datasheet > vision > inferred`.
  A guessed value is never presented as fact — unverifiable values are `null`.
- In the viewer, color is provenance and nothing else:
  green = verified · amber = unverified · red = flagged · cyan = selection/path
  · violet = mods.

## Status

- [x] Stage 1 — server + viewer shell (library, pan/zoom page viewer, invert toggle)
- [x] Stage 2 — hit-testing, info cards, cross-linking
- [x] Stage 3 — review mode, new-device flow, page upload
- [x] Stage 4 — paths/isolation mode, search, mods space, copy-context, reference tab
- [ ] Stage 5 — indexer (ingest → classify → parts list → regions → enrich → validate → report)
  - [x] Stage 1 — ingest (PDF → 300dpi PNG + inverted copies, checkpointed/resumable, `--dry-run`)
  - [ ] Stage 2 — classification + human gate (needs `ANTHROPIC_API_KEY` + a real manual to verify)
  - [ ] Stage 3 — parts-list extraction
  - [ ] Stage 4 — region detection (tiled), stress-test on a dense fold-out page first
  - [ ] Stages 5–7 — enrichment, cross-validation, review queue, datasheet lookup, project-knowledge export

Try it: `node atlas/fixtures/make-fixtures.js && node atlas/server.js`, then open the
printed LAN URL. The fixture device (`fixture-amp`) exercises every viewer feature —
including a schematic↔PCB cross-page signal path — without needing a real manual.
