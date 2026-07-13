#!/usr/bin/env node
/**
 * Builds the extension and packages it into release.zip for Chrome Web Store submission.
 * Usage: node scripts/package.js
 *        npm run package
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const ZIP_NAME = 'release.zip';

// Files/dirs to include in the zip (relative to ROOT)
const INCLUDE = [
  'manifest.json',
  'popup.html',
  'options.html',
  'icons',
  'dist/background.js',
  'dist/content.bundle.js',
  'dist/popup.bundle.js',
  'dist/options.bundle.js',
];

// Config files: copy example → actual so the extension has defaults
const CONFIG_FILES = [
  { src: 'config/questions.json',         dest: 'config/questions.json' },
  { src: 'config/personals.example.json', dest: 'config/personals.json' },
  { src: 'config/personals.example.json', dest: 'config/personals.example.json' },
  { src: 'config/secrets.example.json',   dest: 'config/secrets.json'   },
  { src: 'config/secrets.example.json',   dest: 'config/secrets.example.json' },
];

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  ⚠ Missing: ${src}`);
    return;
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ── Step 1: Build ──────────────────────────────────────────────────────────────
console.log('\n📦  Building extension…');
run('npm run build');

// ── Step 2: Prepare staging dir ───────────────────────────────────────────────
console.log('\n🗂   Staging files…');
if (fs.existsSync(RELEASE_DIR)) fs.rmSync(RELEASE_DIR, { recursive: true });
fs.mkdirSync(RELEASE_DIR, { recursive: true });

for (const rel of INCLUDE) {
  const src  = path.join(ROOT, rel);
  const dest = path.join(RELEASE_DIR, rel);
  copyRecursive(src, dest);
  console.log(`  ✓ ${rel}`);
}

for (const { src, dest } of CONFIG_FILES) {
  const srcPath  = path.join(ROOT, src);
  const destPath = path.join(RELEASE_DIR, dest);
  copyRecursive(srcPath, destPath);
  console.log(`  ✓ ${src} → ${dest}`);
}

// ── Step 3: Zip ───────────────────────────────────────────────────────────────
console.log('\n🔐  Creating zip…');
const zipPath = path.join(ROOT, ZIP_NAME);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

try {
  // Use system zip if available (macOS/Linux)
  run(`zip -r ../${ZIP_NAME} .`, RELEASE_DIR);
} catch {
  // Fallback: use Node's built-in (requires Node 18+)
  console.log('  zip not found, trying node archiver…');
  run('npm install --save-dev archiver --no-save');
  const archiver = require('archiver');
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);
  archive.directory(RELEASE_DIR, false);
  archive.finalize();
}

// ── Done ──────────────────────────────────────────────────────────────────────
const sizeMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`\n✅  Done! → ${ZIP_NAME} (${sizeMB} MB)`);
console.log('   Upload this file to the Chrome Web Store Developer Dashboard.');
console.log('   https://chrome.google.com/webstore/devconsole\n');
