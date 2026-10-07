'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const PE = require('pe-library');
const ResEdit = require('resedit');
const {
  PRODUCT_NAME, SOURCE_RUNTIME, BRANDED_RUNTIME, ICON_PATH,
  parseDataPack, writeDataPack, dataPackResource, patchLocalePack,
  patchPeResources, patchProductArtwork, patchScaledProductArtwork, replaceProductText, stageBrandedRuntime, readApplicationVersion, buildNativeAboutTemplate, patchNativeAboutTemplate,
} = require('../scripts/brand-native-resources');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hasRuntime = fs.existsSync(path.join(SOURCE_RUNTIME, 'chrome.exe'));
// Sole intentional URL repair: the first project link in About's license
// text. The ungoogled runtime's $1 expands to a nonfunctional domain.
const expectedProjectUrlRepair = text => text.replace('href="$1"', 'href="https://www.chromium.org/"').replace('href="https://www.ch40m1um.qjz9zk/"', 'href="https://www.chromium.org/"');

test('DataPack v4/v5 round trips preserve arbitrary binary payloads and aliases', () => {
  for (const version of [4, 5]) {
    const pack = { version, encoding: 0, entries: [{ id: 10, data: Buffer.from([0, 255, 128, 13, 0]) }, { id: 55, data: Buffer.from('second') }], aliases: version === 5 ? [{ id: 11, index: 0 }, { id: 300, index: 1 }] : [] };
    const bytes = writeDataPack(pack);
    const parsed = parseDataPack(bytes);
    assert.deepEqual(parsed.entries, pack.entries);
    assert.deepEqual(parsed.aliases, pack.aliases);
    assert.deepEqual(writeDataPack(parsed), bytes);
    if (version === 5) assert.deepEqual(dataPackResource(parsed, 300).data, pack.entries[1].data);
    assert.throws(() => parseDataPack(bytes.subarray(0, bytes.length - 1)));
    const corrupted = Buffer.from(bytes);
    corrupted.writeUInt32LE(bytes.length + 9, version === 5 ? 14 : 11);
    assert.throws(() => parseDataPack(corrupted));
  }
});

test('Native About presents app and actual engine versions separately while all executable bundle code remains byte-identical', { skip: !hasRuntime }, () => {
  const pack = parseDataPack(fs.readFileSync(path.join(SOURCE_RUNTIME, 'resources.pak')));
  const resource = dataPackResource(pack, 21996).data;
  const original = resource[0] === 31 ? zlib.gunzipSync(resource) : resource;
  const version = readApplicationVersion();
  const patch = patchNativeAboutTemplate(original, { appVersion: version, coreVersion: '150.0.7871.186' });
  const source = original.toString('utf8');
  assert.equal(patch.data.toString('utf8'), source.slice(0, patch.start) + patch.template + source.slice(patch.end));
  assert.deepEqual(patch.data.subarray(0, patch.start), original.subarray(0, patch.start));
  assert.deepEqual(patch.data.subarray(patch.start + Buffer.byteLength(patch.template)), original.subarray(patch.end));
  assert.match(patch.template, new RegExp(`data-peregrine-app-version>游隼浏览器 ${version.replace(/\./g, '\\.')}`));
  assert.match(patch.template, /data-peregrine-engine>Chromium 150\.0\.7871\.186 · Blink/);
  assert.match(patch.template, /Windows · 64 位 \/ 64-bit/);
  assert.match(patch.template, /当前版本需手动安装更新，暂不支持自动更新/);
  assert.match(patch.template, /fingerprint-chromium \/ ungoogled Chromium/);
  assert.match(patch.template, /第三方构建 \/ Third-party build/);
  assert.match(patch.template, /fingerprint-chromium 上游项目 \/ Upstream project/);
  assert.match(patch.template, /data-peregrine-core-copyright/);
  assert.match(patch.template, /\$i18n\{aboutProductCopyright\}/);
  assert.match(patch.template, /\$i18nRaw\{aboutProductLicense\}/);
  assert.match(patch.template, /href="https:\/\/github\.com\/adryfish\/fingerprint-chromium"/);
  assert.match(patch.template, /href="chrome:\/\/credits\/"/);
  assert.match(patch.template, /href="https:\/\/github\.com\/MetaCubeX\/mihomo\/blob\/Meta\/LICENSE"/);
  assert.doesNotMatch(patch.template, /aboutBrowserVersion|up to date|最新版本|©游隼|Copyright.*游隼/i);
  assert.match(patch.template, /id="product-logo"/);
  assert.match(patch.template, /id="product-logo" src="chrome:\/\/theme\/current-channel-logo@2x"/);
  assert.match(patch.template, /id="relaunch"/);
  assert.match(patch.template, /@media\(prefers-color-scheme:dark\)/);
  assert.match(patch.template, /@media\(max-width:600px\)/);
  assert.match(patch.template, /:host\{[^}]*min-width:0!important;width:100%!important;max-width:100%!important;box-sizing:border-box/);
  assert.match(buildNativeAboutTemplate({ appVersion: '0.9.8', coreVersion: '150.0.7871.186' }), /游隼浏览器 0\.9\.8/);
  assert.throws(() => buildNativeAboutTemplate({ appVersion: '<script>1</script>' }), /Invalid application version/);
});

test('Attribution keeps the upstream linked project when locale grammar places that link before the product name', { skip: !hasRuntime }, () => {
  const anchors = text => text.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) || [];
  for (const locale of fs.readdirSync(path.join(SOURCE_RUNTIME, 'locales')).filter(name => name.endsWith('.pak'))) {
    const original = parseDataPack(fs.readFileSync(path.join(SOURCE_RUNTIME, 'locales', locale)));
    const before = dataPackResource(original, 34399).data.toString('utf8');
    const after = replaceProductText(before, { attribution: true });
    assert.deepEqual(anchors(after), anchors(expectedProjectUrlRepair(before)), locale);
    assert.match(after.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, ''), /游隼浏览器/, locale);
  }
  const linkFirst = '<a href="https://www.chromium.org/">Chromium</a> project makes Chromium possible.';
  assert.equal(replaceProductText(linkFirst, { attribution: true }), '<a href="https://www.chromium.org/">Chromium</a> project makes 游隼浏览器 possible.');
  const placeholder = 'Chromium: <a href="https://www.ch40m1um.qjz9zk/" aria-description="$3">Chromium</a> / <a href="$2">credits</a>';
  assert.equal(replaceProductText(placeholder, { attribution: true }), '游隼浏览器: <a href="https://www.chromium.org/" aria-description="$3">Chromium</a> / <a href="$2">credits</a>');
});

test('Native localized brand labels change while authors, upstream links and unrelated resources remain intact', { skip: !hasRuntime }, () => {
  for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'hi']) {
    const original = fs.readFileSync(path.join(SOURCE_RUNTIME, 'locales', `${locale}.pak`));
    const before = parseDataPack(original);
    const patch = patchLocalePack(original);
    const after = parseDataPack(patch.data);
    assert.equal(dataPackResource(after, 101).data.toString('utf8'), PRODUCT_NAME);
    assert.match(dataPackResource(after, 475).data.toString('utf8'), /游隼浏览器/);
    assert.match(dataPackResource(after, 801).data.toString('utf8'), /游隼浏览器/);
    for (const id of [949, 950]) assert.deepEqual(dataPackResource(after, id).data, dataPackResource(before, id).data);
    const allAnchors = text => text.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) || [];
    assert.deepEqual(allAnchors(dataPackResource(after, 34399).data.toString('utf8')), allAnchors(expectedProjectUrlRepair(dataPackResource(before, 34399).data.toString('utf8'))));
    assert.match(dataPackResource(after, 34399).data.toString('utf8'), /游隼浏览器/);
    assert.deepEqual(after.aliases, before.aliases);
    const changed = new Set(patch.changes);
    for (let i = 0; i < before.entries.length; i += 1) {
      assert.equal(after.entries[i].id, before.entries[i].id);
      if (!changed.has(before.entries[i].id)) assert.deepEqual(after.entries[i].data, before.entries[i].data);
      const links = text => text.match(/<[^>]+>|(?:https?|chrome):\/\/[^\s<>"']+/g) || [];
      const expectedBefore = before.entries[i].id === 34399 ? expectedProjectUrlRepair(before.entries[i].data.toString('utf8')) : before.entries[i].data.toString('utf8');
      assert.deepEqual(links(after.entries[i].data.toString('utf8')), links(expectedBefore));
    }
    assert.deepEqual(patchLocalePack(original).data, patch.data);
  }
});

test('Native product art is replaced with existing Peregrine icon pixels; other binary resources and aliases stay identical', { skip: !hasRuntime }, () => {
  const original = fs.readFileSync(path.join(SOURCE_RUNTIME, 'resources.pak'));
  const before = parseDataPack(original);
  const icon = fs.readFileSync(ICON_PATH);
  const patch = patchProductArtwork(original, icon);
  const after = parseDataPack(patch.data);
  const sourceIcon = ResEdit.Data.IconFile.from(icon);
  const png128 = Buffer.from(sourceIcon.icons.find(item => item.data.width === 128).data.bin);
  assert.deepEqual(dataPackResource(after, 15151).data, png128);
  assert.deepEqual(dataPackResource(after, 15190).data, png128); // alias of the same 128px logo
  const svgData = dataPackResource(after, 15154).data;
  const svg = svgData[0] === 31 ? zlib.gunzipSync(svgData).toString('utf8') : svgData.toString('utf8');
  assert.match(svg, /data:image\/png;base64,/);
  const darkData = dataPackResource(after, 50906).data;
  const darkSvg = zlib.gunzipSync(darkData).toString('utf8');
  const png24 = Buffer.from(sourceIcon.icons.find(item => item.data.width === 24).data.bin);
  assert.match(darkSvg, /width="24" height="24"/);
  assert.deepEqual(Buffer.from(darkSvg.match(/base64,([^"']+)/)[1], 'base64'), png24);
  const uncompressedText = data => (data[0] === 31 ? zlib.gunzipSync(data) : data).toString('utf8');
  const productGlyph = /<g id="chrome-product" viewBox="0 -960 960 960">[\s\S]*?<\/g>/g;
  for (const id of [703, 17763, 19413, 19471, 19704, 19802, 20524, 20637, 20831, 21051, 21682, 21790, 21998, 22931, 22942, 23153, 23428, 50697]) {
    const oldUi = uncompressedText(dataPackResource(before, id).data);
    const newUi = uncompressedText(dataPackResource(after, id).data);
    assert.equal(oldUi.replace(productGlyph, '<product-glyph/>'), newUi.replace(productGlyph, '<product-glyph/>'), `WebUI ${id} executable JavaScript must stay identical`);
    const navigationPng = newUi.match(productGlyph)[0].match(/base64,([^"']+)/)[1];
    assert.deepEqual(Buffer.from(navigationPng, 'base64'), png24);
  }
  assert.deepEqual(after.aliases, before.aliases);
  const changed = new Set(patch.changes);
  for (let i = 0; i < before.entries.length; i += 1) if (!changed.has(before.entries[i].id)) assert.deepEqual(after.entries[i], before.entries[i]);
  assert.deepEqual(patchProductArtwork(original, icon).data, patch.data);
});

test('Settings and About current-channel-logo use branded PNGs at both native display scales', { skip: !hasRuntime }, () => {
  const icon = fs.readFileSync(ICON_PATH);
  const sourceIcon = ResEdit.Data.IconFile.from(icon);
  for (const scale of [1, 2]) {
    const original = fs.readFileSync(path.join(SOURCE_RUNTIME, `chrome_${scale * 100}_percent.pak`));
    const before = parseDataPack(original);
    const result = patchScaledProductArtwork(original, icon, scale);
    const after = parseDataPack(result.data);
    for (const [id, size] of [[15315, 32 * scale], [15317, 16 * scale]]) {
      const desired = sourceIcon.icons.find(item => item.data.width === size);
      assert.deepEqual(dataPackResource(after, id).data, Buffer.from(desired.data.bin));
    }
    assert.deepEqual(after.aliases, before.aliases);
    for (let i = 0; i < before.entries.length; i += 1) if (!result.changes.includes(before.entries[i].id)) assert.deepEqual(after.entries[i], before.entries[i]);
    assert.deepEqual(patchScaledProductArtwork(original, icon, scale).data, result.data);
  }
});

test('PE branding changes product name and main icon but preserves machine code, core version and original copyright', { skip: !hasRuntime }, () => {
  const original = fs.readFileSync(path.join(SOURCE_RUNTIME, 'chrome.exe'));
  const patch = patchPeResources(original, fs.readFileSync(ICON_PATH), 'chrome.exe');
  const oldExe = PE.NtExecutable.from(original);
  const newExe = PE.NtExecutable.from(patch.data);
  for (const oldSection of oldExe.getAllSections().filter(section => section.info.name !== '.rsrc')) {
    const newSection = newExe.getAllSections().find(section => section.info.name === oldSection.info.name);
    assert.deepEqual(Buffer.from(newSection.data), Buffer.from(oldSection.data));
    if (oldSection.info.name !== '.reloc') assert.equal(newSection.info.virtualAddress, oldSection.info.virtualAddress);
  }
  const beforeResource = PE.NtExecutableResource.from(oldExe);
  const afterResource = PE.NtExecutableResource.from(newExe);
  const beforeVersion = ResEdit.Resource.VersionInfo.fromEntries(beforeResource.entries)[0].getStringValues({ lang: 1033, codepage: 1200 });
  const afterVersion = ResEdit.Resource.VersionInfo.fromEntries(afterResource.entries)[0].getStringValues({ lang: 1033, codepage: 1200 });
  assert.equal(afterVersion.ProductName, PRODUCT_NAME);
  assert.equal(afterVersion.FileDescription, PRODUCT_NAME);
  for (const key of ['FileVersion', 'ProductVersion', 'LegalCopyright', 'CompanyName', 'OriginalFilename', 'InternalName']) assert.equal(afterVersion[key], beforeVersion[key]);
  assert.deepEqual(patch.iconGroups.map(group => group.id), ['IDR_MAINFRAME', 'IDR_X001_APP_LIST']);
  const oldIncognito = beforeResource.entries.find(entry => entry.type === 14 && entry.id === 'IDR_X003_INCOGNITO');
  const newIncognito = afterResource.entries.find(entry => entry.type === 14 && entry.id === 'IDR_X003_INCOGNITO');
  assert.deepEqual(Buffer.from(newIncognito.bin), Buffer.from(oldIncognito.bin));
  assert.deepEqual(patchPeResources(original, fs.readFileSync(ICON_PATH), 'chrome.exe').data, patch.data);
});

test('Branding refuses original/overlapping runtime locations before copying or editing', { skip: !hasRuntime }, () => {
  assert.throws(() => stageBrandedRuntime({ sourceDir: SOURCE_RUNTIME, destinationDir: SOURCE_RUNTIME }), /separate/);
  assert.throws(() => stageBrandedRuntime({ sourceDir: SOURCE_RUNTIME, destinationDir: path.join(SOURCE_RUNTIME, 'brand') }), /separate/);
  assert.throws(() => stageBrandedRuntime({ sourceDir: SOURCE_RUNTIME, destinationDir: path.dirname(SOURCE_RUNTIME) }), /separate/);
});

test('Staged native manifest matches both untouched upstream and branded distribution files', { skip: !fs.existsSync(path.join(BRANDED_RUNTIME, 'brand-manifest.json')) }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BRANDED_RUNTIME, 'brand-manifest.json'), 'utf8'));
  assert.equal(manifest.productName, PRODUCT_NAME);
  assert.equal(manifest.engine, 'Chromium');
  assert.equal(manifest.appVersion, readApplicationVersion());
  assert.equal(manifest.coreVersion, '150.0.7871.186');
  assert.equal(manifest.upstreamExecutableSha256, '65d0807599b5430ffbd9dffb60cd020464815f10557352959e3aa4c125a5c439');
  for (const entry of manifest.files) {
    assert.equal(sha256(fs.readFileSync(path.join(SOURCE_RUNTIME, entry.path))), entry.originalSha256);
    assert.equal(sha256(fs.readFileSync(path.join(BRANDED_RUNTIME, entry.path))), entry.brandedSha256);
    for (const section of entry.nonResourceSections || []) assert.equal(section.unchanged, true);
  }
});
