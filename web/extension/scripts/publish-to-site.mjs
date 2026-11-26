// Zips the built extension for the site's Extension page and writes the
// manifest the page checks for updates:
//
//   web/app/public/downloads/nikomusic-extension-chrome.zip
//   web/app/public/downloads/nikomusic-extension-firefox.zip
//   web/app/public/downloads/extension.json    { version, builtAt, files }
//
// Each zip places manifest.json directly at the archive root so Chrome and
// Firefox tools can inspect or unpack it without an extra wrapper directory.
//
//   corepack pnpm --dir web/extension package   (builds both, then runs this)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const output = fileURLToPath(new URL('../.output/', import.meta.url));
const target = fileURLToPath(new URL('../../app/public/downloads/', import.meta.url));
mkdirSync(target, { recursive: true });
// Remove any previous chrome/firefox zips (including legacy version-named files).
for (const name of readdirSync(target)) if (/^nikomusic-extension-.*\.zip$/.test(name)) rmSync(join(target, name));

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const builds = { chrome: 'chrome-mv3', firefox: 'firefox-mv3' };
const files = {};
let version;

for (const [browser, folder] of Object.entries(builds)) {
  const root = join(output, folder);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing built ${browser} manifest at ${manifestPath}; run wxt build first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (version && manifest.version !== version) {
    throw new Error(`Chrome and Firefox builds disagree on the version (${version} vs ${manifest.version}); rebuild both`);
  }
  version = manifest.version;

  const entries = {};
  for (const file of filesUnder(root)) {
    entries[relative(root, file).split(sep).join('/')] = readFileSync(file);
  }
  if (!('manifest.json' in entries)) {
    throw new Error(`Expected manifest.json at root of ${browser} archive`);
  }
  const name = `nikomusic-extension-${browser}.zip`;
  writeFileSync(join(target, name), zipSync(entries, { level: 9 }));
  files[browser] = name;
  console.log(`${folder} -> app/public/downloads/${name} (v${version}, ${Object.keys(entries).length} files)`);
}

writeFileSync(
  join(target, 'extension.json'),
  `${JSON.stringify({ version, builtAt: new Date().toISOString(), files }, null, 2)}\n`,
);
console.log(`app/public/downloads/extension.json (v${version})`);
