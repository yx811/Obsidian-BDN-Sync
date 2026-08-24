#!/usr/bin/env node
// Deploy script: copies build artifacts (main.js / styles.css / manifest.json) to the
// Obsidian plugin directory inside your vault.
//
// Obsidian loads plugins from <vault>/.obsidian/plugins/<manifest.id>/, not from the
// repository root. After running `npm run build`, this script deploys the latest
// build so Obsidian picks it up without manual copy-pasting.
//
// Usage (pick one):
//   1) Set environment variable to your vault root:
//        NODE_VAULT="/path/to/your/Obsidian Vault" npm run deploy
//   2) Pass path directly:
//        node scripts/copy-to-vault.cjs "/path/to/your/Obsidian Vault"
//   3) If neither is provided, the script will exit with a clear error message.

const fs = require('fs');
const path = require('path');

function resolveVault() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.NODE_VAULT) return process.env.NODE_VAULT;
  return '';
}

const vault = resolveVault();
const src = process.cwd();

// Plugin directory name is read from manifest.json id to stay in sync with manifest
let pluginId = 'bdnsync';
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  if (manifest && manifest.id) pluginId = manifest.id;
} catch {
  /* fallback to default id */
}

const dst = vault ? path.join(vault, '.obsidian', 'plugins', pluginId) : '';
const files = ['main.js', 'styles.css', 'manifest.json'];

function main() {
  if (!vault) {
    console.error('[deploy] Vault path not specified.');
    console.error('[deploy] Use one of:');
    console.error('  NODE_VAULT="/path/to/vault" npm run deploy');
    console.error('  node scripts/copy-to-vault.cjs "/path/to/vault"');
    process.exit(1);
  }

  if (!fs.existsSync(dst)) {
    console.error('[deploy] Plugin directory not found: ' + dst);
    console.error('[deploy] Make sure Obsidian has created the plugin directory first.');
    process.exit(1);
  }

  for (const f of files) {
    const a = path.join(src, f);
    const b = path.join(dst, f);
    if (!fs.existsSync(a)) {
      console.error('[deploy] Missing source file. Run `npm run build` first: ' + a);
      process.exit(1);
    }
    fs.copyFileSync(a, b);
    const sz = fs.statSync(b).size;
    console.log('[deploy] ' + f + ' -> ' + b + ' (' + sz + ' bytes)');
  }
  console.log('[deploy] Done. Run "Reload app" in Obsidian to load the new version.');
}

main();
