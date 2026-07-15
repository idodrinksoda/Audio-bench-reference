// Fail-fast checks for the external CLI tools ingest depends on.
// Both are standard PDF/image toolchain pieces — documented in the README.

'use strict';

const { spawnSync } = require('child_process');

function checkTool(cmd, args, installHint) {
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  if (res.error || res.status === null) {
    throw new Error(
      `required tool "${cmd}" not found on PATH.\n` +
      `  Install it: ${installHint}`
    );
  }
}

function checkIngestTools() {
  checkTool('pdftoppm', ['-v'],
    'macOS: brew install poppler | Debian/Ubuntu: sudo apt install poppler-utils | Windows: use WSL or https://github.com/oschwartz10612/poppler-windows');
  checkTool('convert', ['-version'],
    'macOS: brew install imagemagick | Debian/Ubuntu: sudo apt install imagemagick | Windows: https://imagemagick.org/script/download.php');
}

module.exports = { checkTool, checkIngestTools };
