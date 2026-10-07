'use strict';

// Recover the pinned official Electron runtime without changing package.json,
// npm's installer, or the app. Both the archive and checksum come from Electron.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const VERSION = '44.5.1';
const TAG = `v${VERSION}`;
const ASSET_NAME = `electron-${TAG}-win32-x64.zip`;
const RELEASE_ROOT = `https://github.com/electron/electron/releases/download/${TAG}/`;
const electronRoot = path.resolve(__dirname, '../node_modules/electron');
const headers = { 'User-Agent': 'PeregrineBrowser-build/0.1' };
const approvedHosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function removeOwnedDirectory(root, directory, prefix) {
  const resolved = path.resolve(directory);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith(prefix)) {
    throw new Error('Refusing to remove a directory outside the runtime staging area.');
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Runtime command failed (${code}): ${output.slice(-2000)}`)));
  });
}

async function installed() {
  try {
    return (await fs.readFile(path.join(electronRoot, 'dist/version'), 'utf8')).trim().replace(/^v/, '') === VERSION
      && (await fs.stat(path.join(electronRoot, 'dist/electron.exe'))).isFile();
  } catch { return false; }
}

async function fetchOfficial(url, accept = 'application/octet-stream') {
  if (!approvedHosts.has(new URL(url).hostname)) throw new Error('Refusing a non-official download URL.');
  const response = await fetch(url, { headers: { ...headers, Accept: accept }, signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Official download failed (HTTP ${response.status}).`);
  if (!approvedHosts.has(new URL(response.url).hostname)) throw new Error('Official download redirected to an unexpected host.');
  return response;
}

async function readSmall(url, accept, maxBytes = 4 * 1024 * 1024) {
  const response = await fetchOfficial(url, accept);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Official metadata exceeded the permitted size.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadArchive(url, destination, expectedSize, expectedHash) {
  const response = await fetchOfficial(url);
  const digest = crypto.createHash('sha256');
  const handle = await fs.open(destination, 'wx');
  let bytes = 0;
  let progress = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 250 * 1024 * 1024 || (expectedSize && bytes > expectedSize)) throw new Error('Official runtime archive exceeded its expected size.');
      digest.update(chunk);
      await handle.write(chunk);
      if (bytes - progress > 20 * 1024 * 1024) {
        progress = bytes;
        console.log(`Downloaded ${Math.floor(bytes / 1024 / 1024)} MB of the official runtime.`);
      }
    }
  } finally { await handle.close(); }
  if (expectedSize && bytes !== expectedSize) throw new Error('Official runtime archive length does not match release metadata.');
  if (digest.digest('hex') !== expectedHash) throw new Error('Official runtime archive SHA-256 verification failed.');
  return bytes;
}

async function resumeOfficialArchive(url, archivePath, expectedSize, stageRoot) {
  const startingSize = (await fs.stat(archivePath)).size;
  if (startingSize < 0 || startingSize > expectedSize) throw new Error('Partial official archive length is invalid.');
  if (startingSize === expectedSize) return;
  const head = await fetchOfficial(url);
  if (!head.ok || !approvedHosts.has(new URL(head.url).hostname)) throw new Error('Could not resolve the official GitHub runtime URL.');
  await head.body.cancel();
  const partLength = Math.ceil((expectedSize - startingSize) / 12);
  const parts = [];
  for (let offset = startingSize; offset < expectedSize; offset += partLength) {
    parts.push({ start: offset, end: Math.min(expectedSize - 1, offset + partLength - 1), file: path.join(stageRoot, `part-${parts.length}.bin`) });
  }
  let completed = startingSize;
  console.log(`Resuming the official runtime from ${Math.floor(startingSize / 1024 / 1024)} MB using ${parts.length} verified HTTP ranges.`);
  await Promise.all(parts.map(async part => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(head.url, {
          headers: { ...headers, Range: `bytes=${part.start}-${part.end}` },
          signal: AbortSignal.timeout(300000),
        });
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${part.start}-${part.end}/${expectedSize}`) {
          await response.body?.cancel().catch(() => {});
          throw new Error('The official CDN did not return the requested byte range.');
        }
        const handle = await fs.open(part.file, 'w');
        let bytes = 0;
        try {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > part.end - part.start + 1) throw new Error('The official CDN range exceeded its expected size.');
            await handle.write(chunk);
          }
        } finally { await handle.close(); }
        if (bytes !== part.end - part.start + 1) throw new Error('The official CDN byte range was incomplete.');
        completed += bytes;
        console.log(`Official runtime ranges downloaded: ${Math.floor(completed / 1024 / 1024)} / ${Math.ceil(expectedSize / 1024 / 1024)} MB.`);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }));
  const output = await fs.open(archivePath, 'a');
  try {
    for (const part of parts) for await (const chunk of fsSync.createReadStream(part.file)) await output.write(chunk);
  } finally { await output.close(); }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This recovery script is for Windows x64.');
  if (JSON.parse(await fs.readFile(path.join(electronRoot, 'package.json'), 'utf8')).version !== VERSION) throw new Error('Installed Electron npm package does not match the pinned version.');
  if (await installed()) {
    await fs.writeFile(path.join(electronRoot, 'path.txt'), 'electron.exe');
    console.log(`Official Electron ${VERSION} runtime is already installed; download skipped.`);
    return;
  }

  const release = JSON.parse(await readSmall(`https://api.github.com/repos/electron/electron/releases/tags/${TAG}`, 'application/vnd.github+json'));
  if (release.tag_name !== TAG || !Array.isArray(release.assets)) throw new Error('Pinned official Electron release was not found.');
  const archiveAsset = release.assets.find(asset => asset.name === ASSET_NAME);
  const checksumAsset = release.assets.find(asset => asset.name === 'SHASUMS256.txt');
  if (!archiveAsset || !checksumAsset || ![archiveAsset, checksumAsset].every(asset => Number.isSafeInteger(asset.id) && asset.id > 0 && asset.browser_download_url.startsWith(RELEASE_ROOT))) {
    throw new Error('Pinned official Electron release assets could not be verified.');
  }

  const apiUrl = asset => `https://api.github.com/repos/electron/electron/releases/assets/${asset.id}?download=1`;
  let checksums;
  try { checksums = await readSmall(apiUrl(checksumAsset), 'application/octet-stream'); }
  catch { checksums = await readSmall(checksumAsset.browser_download_url, 'application/octet-stream'); }
  const checksumLine = checksums.split(/\r?\n/u).map(line => line.trim()).find(line => line.endsWith(ASSET_NAME));
  const expectedHash = checksumLine?.match(/^([a-f\d]{64})\s+\*?/iu)?.[1]?.toLowerCase();
  if (!expectedHash) throw new Error('Official Electron SHA-256 manifest does not contain the Windows x64 archive.');
  const packagedChecksums = JSON.parse(await fs.readFile(path.join(electronRoot, 'checksums.json'), 'utf8'));
  if (packagedChecksums[ASSET_NAME] !== expectedHash) throw new Error('Official release checksum differs from the pinned npm package checksum.');
  if (archiveAsset.digest && archiveAsset.digest !== `sha256:${expectedHash}`) throw new Error('GitHub asset digest differs from the official checksum manifest.');
  console.log(`Verified official release checksum: ${expectedHash}`);

  const suppliedArchiveIndex = process.argv.indexOf('--archive');
  const suppliedArchive = suppliedArchiveIndex < 0 ? '' : process.argv[suppliedArchiveIndex + 1];
  if (suppliedArchiveIndex >= 0 && !suppliedArchive) throw new Error('--archive requires the absolute path of a verified official download.');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-electron-'));
  const archivePath = suppliedArchive ? path.resolve(suppliedArchive) : path.join(tempRoot, ASSET_NAME);
  const extracted = path.join(tempRoot, 'dist');
  try {
    if (suppliedArchive) {
      if (process.argv.includes('--resume')) await resumeOfficialArchive(apiUrl(archiveAsset), archivePath, archiveAsset.size, tempRoot);
      if ((await fs.stat(archivePath)).size !== archiveAsset.size) throw new Error('Supplied official runtime archive is incomplete.');
      const digest = crypto.createHash('sha256');
      for await (const chunk of fsSync.createReadStream(archivePath)) digest.update(chunk);
      if (digest.digest('hex') !== expectedHash) throw new Error('Supplied official runtime archive SHA-256 verification failed.');
    } else {
      try { await downloadArchive(apiUrl(archiveAsset), archivePath, archiveAsset.size, expectedHash); }
      catch (error) {
        await fs.rm(archivePath, { force: true });
        console.log('Retrying through the direct official GitHub release URL.');
        await downloadArchive(archiveAsset.browser_download_url, archivePath, archiveAsset.size, expectedHash);
      }
    }
    console.log('Official runtime archive SHA-256 verified. Extracting the runtime.');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:PEREGRINE_ELECTRON_ARCHIVE -DestinationPath $env:PEREGRINE_ELECTRON_STAGE'], {
      env: { ...process.env, PEREGRINE_ELECTRON_ARCHIVE: archivePath, PEREGRINE_ELECTRON_STAGE: extracted },
    });
    const executable = path.join(extracted, 'electron.exe');
    if ((await fs.readFile(path.join(extracted, 'version'), 'utf8')).trim().replace(/^v/, '') !== VERSION || !(await fs.stat(executable)).isFile()) throw new Error('Extracted runtime does not match the pinned version.');
    const magic = Buffer.alloc(2);
    const handle = await fs.open(executable, 'r');
    try { await handle.read(magic, 0, 2, 0); } finally { await handle.close(); }
    if (magic.toString('ascii') !== 'MZ') throw new Error('Official runtime executable has an invalid format.');
    if (await installed()) { console.log('Another installer completed the runtime; keeping its installed files.'); return; }
    const target = path.join(electronRoot, 'dist');
    if (fsSync.existsSync(target)) throw new Error('An incomplete runtime directory already exists; refusing to overwrite concurrent installer output.');
    // tempRoot may reside on a different Windows volume, so copy before publishing.
    const staged = path.join(electronRoot, `.runtime-${crypto.randomUUID()}`);
    try {
      await fs.cp(extracted, staged, { recursive: true, errorOnExist: true, force: false });
      await fs.rename(staged, target);
    } finally { await removeOwnedDirectory(electronRoot, staged, '.runtime-').catch(() => {}); }
    await fs.writeFile(path.join(electronRoot, 'path.txt'), 'electron.exe');
    const runtimeEnvironment = { ...process.env };
    delete runtimeEnvironment.ELECTRON_RUN_AS_NODE;
    const runtimeVersion = await run(path.join(target, 'electron.exe'), ['--version'], { env: runtimeEnvironment });
    if (!runtimeVersion.includes(TAG)) throw new Error(`Installed runtime reports an unexpected version: ${runtimeVersion}`);
    console.log(`Installed and verified official Electron ${runtimeVersion}.`);
  } finally { await removeOwnedDirectory(os.tmpdir(), tempRoot, 'peregrine-electron-').catch(() => {}); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
