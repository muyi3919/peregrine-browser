'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const VERSION = 'v1.19.32';
const ASSET_NAME = `mihomo-windows-amd64-compatible-${VERSION}.zip`;
const EXPECTED_SHA256 = '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0';
const PROJECT = 'https://github.com/MetaCubeX/mihomo';
const vendor = path.resolve(__dirname, '../vendor');
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

async function localSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const command = "$p = ([System.Net.WebRequest]::GetSystemWebProxy()).GetProxy([Uri]'https://github.com'); if ($p.Host -in @('127.0.0.1','localhost','::1') -and -not $p.UserInfo -and $p.Scheme -in @('http','https')) { Write-Output $p.AbsoluteUri }";
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 5000, maxBuffer: 2048,
    });
    const proxy = new URL(result.stdout.trim());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) || proxy.username || proxy.password) return null;
    return proxy.href;
  } catch { return null; }
}

async function download(url, limit = 100 * 1024 * 1024, accept = '*/*') {
  // The Windows curl transport cooperates with common system networking setups
  // where a Node process cannot connect to a DNS fake-IP directly.
  if (process.platform === 'win32') {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-download-'));
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error('Invalid temporary download directory.');
    const outputPath = path.join(temporary, 'official-download');
    try {
      const proxy = await localSystemProxy();
      await execFileAsync('curl.exe', [
        '--silent', '--show-error', '--fail', '--location', '--connect-timeout', '15',
        '--max-time', '120', '--retry', '2', '--retry-delay', '2',
        '--header', 'User-Agent: PeregrineBrowser-build/0.1', '--header', `Accept: ${accept}`,
        ...(proxy ? ['--proxy', proxy] : []), '--output', outputPath, url,
      ], { windowsHide: true, timeout: 380000, maxBuffer: 65536 });
      if ((await fs.stat(outputPath)).size > limit) throw new Error('Official download exceeds the expected size.');
      return await fs.readFile(outputPath);
    } catch {
      throw new Error('Official download failed; check network access to GitHub and release-assets.githubusercontent.com.');
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'PeregrineBrowser-build/0.1', Accept: accept },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error(`Official download failed (HTTP ${response.status}).`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) {
      await response.body.cancel().catch(() => {});
      throw new Error('Official download exceeds the expected size.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Extract a single known executable from the verified official ZIP. No archive
// paths are written to disk, so ZIP traversal entries cannot escape vendor/.
function extractExecutable(zip) {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('Official archive is not a supported ZIP.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const found = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid official ZIP directory.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedLength = zip.readUInt32LE(offset + 20);
    const length = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (/(^|\/)mihomo[\w.-]*\.exe$/u.test(name)) {
      if ((flags & 1) || length > 150 * 1024 * 1024 || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Unsupported official executable entry.');
      const dataOffset = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const compressed = zip.subarray(dataOffset, dataOffset + compressedLength);
      const binary = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: 150 * 1024 * 1024 }) : null;
      if (!binary || binary.length !== length || binary.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Official executable extraction failed.');
      found.push(binary);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (found.length !== 1) throw new Error('Expected exactly one mihomo executable in the official ZIP.');
  return found[0];
}

async function main() {
  const release = JSON.parse((await download(`https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${VERSION}`, 4 * 1024 * 1024)).toString('utf8'));
  const asset = release.assets.find(item => item.name === ASSET_NAME);
  if (!asset || release.tag_name !== VERSION || !asset.browser_download_url.startsWith(`${PROJECT}/releases/download/${VERSION}/`)) throw new Error('Pinned official release asset was not found.');
  if (asset.digest && asset.digest !== `sha256:${EXPECTED_SHA256}`) throw new Error('GitHub release digest differs from the pinned checksum.');
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error('Official release asset ID was not found.');
  const downloadUrl = `https://api.github.com/repos/MetaCubeX/mihomo/releases/assets/${asset.id}?download=1`;
  const archiveArgument = process.argv.indexOf('--archive');
  const archivePath = archiveArgument >= 0 ? process.argv[archiveArgument + 1] : null;
  if (archiveArgument >= 0 && !archivePath) throw new Error('--archive requires a verified official ZIP path.');
  const [archive, license] = await Promise.all([
    archivePath ? fs.readFile(path.resolve(archivePath)) : download(downloadUrl, 100 * 1024 * 1024, 'application/octet-stream'),
    download(`https://raw.githubusercontent.com/MetaCubeX/mihomo/${VERSION}/LICENSE`, 100000),
  ]);
  if (hash(archive) !== EXPECTED_SHA256) throw new Error('SHA-256 verification of the official ZIP failed.');
  const licenseText = license.toString('utf8');
  if (!licenseText.includes('GNU GENERAL PUBLIC LICENSE') || !licenseText.includes('Version 3, 29 June 2007') || license.length < 30000) throw new Error('Full upstream GPL-3 license was not retrieved.');
  const executable = extractExecutable(archive);
  await fs.mkdir(vendor, { recursive: true });
  await fs.writeFile(path.join(vendor, 'mihomo.exe'), executable);
  await fs.writeFile(path.join(vendor, 'mihomo-LICENSE.txt'), license);
  await fs.writeFile(path.join(vendor, 'mihomo-source.json'), JSON.stringify({
    project: PROJECT,
    version: VERSION,
    releaseUrl: `${PROJECT}/releases/tag/${VERSION}`,
    assetName: ASSET_NAME,
    assetUrl: asset.browser_download_url,
    downloadApiUrl: downloadUrl,
    officialDigest: asset.digest || null,
    archiveSha256: EXPECTED_SHA256,
    binarySha256: hash(executable),
    license: 'GPL-3.0-or-later',
    licenseFile: 'mihomo-LICENSE.txt',
    sourceUrl: `${PROJECT}/archive/refs/tags/${VERSION}.zip`,
    sourceRepository: `${PROJECT}/tree/${VERSION}`,
    retrievedAt: new Date().toISOString(),
  }, null, 2) + '\n');
  console.log(`Installed official mihomo ${VERSION}; archive SHA-256 verified.`);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { extractExecutable, main };
