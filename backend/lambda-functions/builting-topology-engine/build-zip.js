// build-zip.js — creates builting-topology-engine.zip using Node.js built-ins
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const out = path.join(dir, 'builting-topology-engine.zip');

// Remove existing zip
if (fs.existsSync(out)) fs.unlinkSync(out);

// Collect files to zip (exclude .zip and .DS_Store and this script)
const files = fs.readdirSync(dir).filter(f =>
  !f.endsWith('.zip') &&
  f !== '.DS_Store' &&
  f !== 'build-zip.js'
);

console.log('Files to zip:', files);

// Use /usr/bin/zip
const args = [out, ...files];
try {
  const result = execFileSync('/usr/bin/zip', args, { cwd: dir, encoding: 'utf8' });
  console.log(result);
} catch (e) {
  console.error('zip failed:', e.message);
  process.exit(1);
}

const size = fs.statSync(out).size;
console.log('Done. Size: ' + (size / 1024).toFixed(1) + ' KB  (' + out + ')');
