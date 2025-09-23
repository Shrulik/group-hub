const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist', 'extension');
const manifestSrc = path.join(root, 'src', 'manifest.json');
const iconsSrc = path.join(root, 'src', 'icons');
const popupDist = path.join(root, 'group-hub', 'dist', 'group-hub', 'browser');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyManifest() {
  if (!fs.existsSync(manifestSrc)) {
    throw new Error('Missing manifest.json at src/manifest.json');
  }
  fs.copyFileSync(manifestSrc, path.join(distDir, 'manifest.json'));
}

function copyPopup() {
  if (!fs.existsSync(popupDist)) {
    throw new Error('Angular build not found. Run "npm run build:ui" first.');
  }
  const targetDir = path.join(distDir, 'group-hub');
  fs.rmSync(targetDir, { force: true, recursive: true });
  fs.cpSync(popupDist, targetDir, { recursive: true });
}

function copyIcons() {
  if (!fs.existsSync(iconsSrc)) {
    console.warn('[Group Hub] Icons directory missing, skipping icon copy');
    return;
  }
  const targetDir = path.join(distDir, 'icons');
  fs.rmSync(targetDir, { force: true, recursive: true });
  fs.cpSync(iconsSrc, targetDir, { recursive: true });
}

function main() {
  ensureDir(distDir);
  copyManifest();
  copyIcons();
  copyPopup();
}

main();
