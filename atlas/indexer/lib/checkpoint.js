// Per-device checkpoint file — a crash resumes, never restarts.
// Stage functions read what's already recorded, do only the missing work,
// and save after every unit of progress (per page, not per stage).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function checkpointPath(workDir) {
  return path.join(workDir, 'checkpoint.json');
}

function loadCheckpoint(workDir) {
  const file = checkpointPath(workDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveCheckpoint(workDir, data) {
  fs.mkdirSync(workDir, { recursive: true });
  const file = checkpointPath(workDir);
  const tmp = path.join(workDir, '.checkpoint.json.tmp-' + crypto.randomBytes(4).toString('hex'));
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { loadCheckpoint, saveCheckpoint, checkpointPath };
