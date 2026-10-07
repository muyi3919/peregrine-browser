'use strict';

// Resource-only distribution branding. The upstream runtime is never modified.
// DataPack layout: Chromium ui/base/resource/data_pack.cc (format v4 and v5).
// Keep Chromium author/copyright, open-source project references, executable
// instructions and internal chrome:// URLs exactly as provided upstream.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const PE = require('pe-library');
const ResEdit = require('resedit');

const PRODUCT_NAME = '游隼浏览器';
const BRANDING_VERSION = 11;
const SOURCE_RUNTIME = path.resolve(__dirname, '../vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64');
const BRANDED_RUNTIME = path.resolve(__dirname, '../vendor/peregrine-chromium/runtime');
const ICON_PATH = path.resolve(__dirname, '../ui/assets/peregrine.ico');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function readApplicationVersion() {
  return validateApplicationVersion(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version);
}

function validateApplicationVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid application version for native About page');
  return version;
}

function buildNativeAboutTemplate({ appVersion = readApplicationVersion(), coreVersion = '150.0.7871.186' } = {}) {
  validateApplicationVersion(appVersion);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(coreVersion)) throw new Error('Invalid Chromium core version');
  return `
    <style include="cr-shared-style settings-shared">
      :host{display:block;min-width:0!important;width:100%!important;max-width:100%!important;box-sizing:border-box;--peregrine-accent:#2477d6;--peregrine-border:rgba(70,125,183,.18);--peregrine-panel:rgba(61,137,219,.045)}
      .peregrine-about{box-sizing:border-box;max-width:900px;padding:4px 0 28px;color:var(--cr-primary-text-color);line-height:1.65;overflow-wrap:anywhere}
      .peregrine-card{box-sizing:border-box;margin-bottom:18px;padding:22px 26px;background:var(--cr-card-background-color,#fff);border:1px solid var(--peregrine-border);border-radius:16px;min-width:0}
      .peregrine-hero{display:flex;align-items:center;gap:20px;background:linear-gradient(135deg,rgba(44,146,234,.13),rgba(41,105,201,.035));border-color:rgba(60,144,224,.25)}
      #product-logo{width:64px;height:64px;flex-shrink:0;border-radius:16px;box-shadow:0 8px 24px rgba(20,72,130,.12)}
      .peregrine-title{margin:0;color:var(--cr-primary-text-color);font-size:24px;font-weight:650;letter-spacing:.04em;line-height:1.4}
      .peregrine-subtitle{margin-top:4px;color:var(--cr-secondary-text-color);font-size:13px}
      .peregrine-description{margin:14px 0 0;font-size:14px;color:var(--cr-secondary-text-color)}
      .peregrine-heading{margin:0 0 14px;font-size:15px;font-weight:650;color:var(--cr-primary-text-color)}
      .peregrine-fields{display:grid;grid-template-columns:148px minmax(0,1fr);gap:10px 16px;margin:0;font-size:13px}
      .peregrine-fields dt{margin:0;color:var(--cr-secondary-text-color)}
      .peregrine-fields dd{min-width:0;margin:0;color:var(--cr-primary-text-color)}
      .peregrine-version{font-weight:600;color:var(--peregrine-accent)}
      .peregrine-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
      .peregrine-chip{padding:4px 10px;border:1px solid var(--peregrine-border);border-radius:8px;background:var(--peregrine-panel);color:var(--cr-secondary-text-color);font-size:12px}
      .peregrine-note{margin:0;color:var(--cr-secondary-text-color);font-size:13px}
      .peregrine-links{display:flex;gap:10px 18px;flex-wrap:wrap;margin-top:12px;font-size:13px}
      .peregrine-links a,.peregrine-license a{color:var(--cr-link-color,var(--peregrine-accent));text-decoration:none}
      .peregrine-links a:hover,.peregrine-license a:hover{text-decoration:underline}
      .peregrine-license{margin-top:12px;padding-top:12px;border-top:1px solid var(--peregrine-border);color:var(--cr-secondary-text-color);font-size:12px}
      .peregrine-license div+div{margin-top:8px}
      @media(prefers-color-scheme:dark){:host{--peregrine-accent:#83bdff;--peregrine-border:rgba(140,185,240,.2);--peregrine-panel:rgba(100,167,241,.08)}.peregrine-hero{background:linear-gradient(135deg,rgba(44,125,210,.2),rgba(33,79,140,.08))}}
      @media(max-width:600px){.peregrine-card{padding:18px 16px;border-radius:12px}.peregrine-hero{gap:14px}#product-logo{width:52px;height:52px;border-radius:13px}.peregrine-title{font-size:21px}.peregrine-fields{grid-template-columns:1fr;gap:3px}.peregrine-fields dd{margin-bottom:10px}}
    </style>
    <article class="peregrine-about" data-peregrine-about>
      <section class="peregrine-card peregrine-hero" aria-label="游隼浏览器 Peregrine Browser">
        <img id="product-logo" src="chrome://theme/current-channel-logo@2x" alt="游隼浏览器图标 Peregrine Browser icon">
        <div><h1 class="peregrine-title">游隼浏览器</h1><div class="peregrine-subtitle">Peregrine Browser · 独立浏览器环境</div><div class="peregrine-description">管理独立环境、代理与浏览器设置，让每个环境有自己的配置。</div></div>
      </section>
      <section class="peregrine-card">
        <h2 class="peregrine-heading">应用信息 · Application</h2>
        <dl class="peregrine-fields">
          <dt>软件版本 / App version</dt><dd class="peregrine-version" data-peregrine-app-version>游隼浏览器 ${appVersion}</dd>
          <dt>运行平台 / Platform</dt><dd>Windows · 64 位 / 64-bit</dd>
          <dt>更新方式 / Updates</dt><dd data-peregrine-manual-update>当前版本需手动安装更新，暂不支持自动更新。<br>Manual installer updates; automatic updates are not supported.</dd>
        </dl>
        <div class="peregrine-chips" aria-label="应用功能 Features"><span class="peregrine-chip">独立环境 / Profiles</span><span class="peregrine-chip">Clash 代理 / Proxy</span><span class="peregrine-chip">可配置指纹 / Fingerprint settings</span><span class="peregrine-chip">虚拟 GPS / Virtual location</span></div>
      </section>
      <section class="peregrine-card">
        <h2 class="peregrine-heading">内核与来源 · Browser engine</h2>
        <dl class="peregrine-fields">
          <dt>内核版本 / Core version</dt><dd data-peregrine-engine>Chromium ${coreVersion} · Blink</dd>
          <dt>内核来源 / Core source</dt><dd>fingerprint-chromium / ungoogled Chromium · 第三方构建 / Third-party build</dd>
          <dt>版本说明 / Version info</dt><dd>上方的软件版本属于游隼应用；此处版本属于第三方浏览器内核。<br>The application and its third-party browser engine use separate version numbers.</dd>
        </dl>
        <div class="peregrine-links"><a href="https://github.com/adryfish/fingerprint-chromium" target="_blank" rel="noopener">fingerprint-chromium 上游项目 / Upstream project</a><a href="https://www.chromium.org/" target="_blank" rel="noopener">Chromium 项目 / Project</a></div>
      </section>
      <section class="peregrine-card">
        <h2 class="peregrine-heading">开源版权与许可 · Third-party licenses</h2>
        <p class="peregrine-note">游隼浏览器为本应用名称。下方版权与许可属于第三方内核及组件。<br>The notices below belong to the upstream engine and third-party components.</p>
        <div class="peregrine-license" data-peregrine-core-copyright><div>内核开源版权 / Upstream core copyright</div><div>$i18n{aboutProductCopyright}</div><div>$i18nRaw{aboutProductLicense}</div></div>
        <div class="peregrine-links"><a href="chrome://credits/" target="_blank" rel="noopener">Chromium 许可清单 / Credits</a><a href="https://github.com/adryfish/fingerprint-chromium/blob/main/LICENSE" target="_blank" rel="noopener">fingerprint-chromium · BSD-3-Clause</a><a href="https://github.com/MetaCubeX/mihomo/blob/Meta/LICENSE" target="_blank" rel="noopener">Mihomo · GPL-3.0</a></div>
      </section>
    </article>
    <div hidden aria-hidden="true">
      <span id="buttonContainer"><cr-button id="relaunch" on-click="onRelaunchClick_">$i18n{aboutRelaunch}</cr-button></span>
      <template is="dom-if" if="[[shouldShowRelaunchDialog]]" restamp><relaunch-confirmation-dialog restart-type="[[restartTypeEnum.RELAUNCH]]" on-close="onRelaunchDialogClose"></relaunch-confirmation-dialog></template>
    </div>
`;
}

function patchNativeAboutTemplate(input, options = {}) {
  const source = Buffer.from(input).toString('utf8');
  const functionStart = source.indexOf('function getTemplate$L(){return html$1`<!--_html_template_start_-->');
  if (functionStart < 0) throw new Error('Unsupported native About template function');
  const startMarker = '<!--_html_template_start_-->';
  const endMarker = '<!--_html_template_end_-->';
  const start = source.indexOf(startMarker, functionStart) + startMarker.length;
  const end = source.indexOf(endMarker, start);
  const originalTemplate = source.slice(start, end);
  if (end < start || !originalTemplate.includes('$i18n{aboutBrowserVersion}') || !originalTemplate.includes('$i18nRaw{aboutProductLicense}')) throw new Error('Unsupported native About template layout');
  const template = buildNativeAboutTemplate(options);
  return { data: Buffer.from(source.slice(0, start) + template + source.slice(end)), originalTemplate, template, start, end };
}

function parseDataPack(input) {
  const data = Buffer.from(input);
  if (data.length < 9) throw new Error('Truncated DataPack header');
  const version = data.readUInt32LE(0);
  if (version !== 4 && version !== 5) throw new Error(`Unsupported DataPack version ${version}`);
  const headerSize = version === 5 ? 12 : 9;
  if (data.length < headerSize) throw new Error('Truncated DataPack header');
  const encoding = data[version === 5 ? 4 : 8];
  if (![0, 1, 2].includes(encoding)) throw new Error('Invalid DataPack text encoding');
  const count = version === 5 ? data.readUInt16LE(8) : data.readUInt32LE(4);
  const aliasCount = version === 5 ? data.readUInt16LE(10) : 0;
  const dataStart = headerSize + (count + 1) * 6 + aliasCount * 4;
  if (dataStart > data.length) throw new Error('Truncated DataPack index');
  const entries = [];
  let lastId = -1;
  for (let i = 0; i < count; i += 1) {
    const id = data.readUInt16LE(headerSize + i * 6);
    const start = data.readUInt32LE(headerSize + i * 6 + 2);
    const end = data.readUInt32LE(headerSize + (i + 1) * 6 + 2);
    if (id <= lastId || start < dataStart || end < start || end > data.length) throw new Error('Invalid DataPack resource index');
    entries.push({ id, data: Buffer.from(data.subarray(start, end)) });
    lastId = id;
  }
  const aliases = [];
  lastId = -1;
  for (let i = 0; i < aliasCount; i += 1) {
    const offset = headerSize + (count + 1) * 6 + i * 4;
    const id = data.readUInt16LE(offset);
    const index = data.readUInt16LE(offset + 2);
    if (id <= lastId || index >= count || entries.some(entry => entry.id === id)) throw new Error('Invalid DataPack alias index');
    aliases.push({ id, index });
    lastId = id;
  }
  if (data.readUInt32LE(headerSize + count * 6 + 2) !== data.length) throw new Error('Trailing DataPack data');
  return { version, encoding, entries, aliases, padding: version === 5 ? Buffer.from(data.subarray(5, 8)) : Buffer.alloc(0) };
}

function writeDataPack(pack) {
  const { version, encoding, entries, aliases = [] } = pack;
  if (![4, 5].includes(version) || ![0, 1, 2].includes(encoding)) throw new Error('Invalid DataPack metadata');
  if (version === 4 && aliases.length) throw new Error('DataPack v4 does not support aliases');
  if (version === 5 && (entries.length > 65535 || aliases.length > 65535)) throw new Error('DataPack index overflow');
  const headerSize = version === 5 ? 12 : 9;
  const indexSize = headerSize + (entries.length + 1) * 6 + aliases.length * 4;
  const index = Buffer.alloc(indexSize);
  index.writeUInt32LE(version, 0);
  if (version === 5) {
    index[4] = encoding;
    if (pack.padding) Buffer.from(pack.padding).copy(index, 5, 0, 3);
    index.writeUInt16LE(entries.length, 8);
    index.writeUInt16LE(aliases.length, 10);
  } else {
    index.writeUInt32LE(entries.length, 4);
    index[8] = encoding;
  }
  let offset = indexSize;
  for (let i = 0; i < entries.length; i += 1) {
    index.writeUInt16LE(entries[i].id, headerSize + i * 6);
    index.writeUInt32LE(offset, headerSize + i * 6 + 2);
    offset += entries[i].data.length;
  }
  index.writeUInt32LE(offset, headerSize + entries.length * 6 + 2);
  for (let i = 0; i < aliases.length; i += 1) {
    const at = headerSize + (entries.length + 1) * 6 + i * 4;
    index.writeUInt16LE(aliases[i].id, at);
    index.writeUInt16LE(aliases[i].index, at + 2);
  }
  const output = Buffer.concat([index, ...entries.map(entry => Buffer.from(entry.data))], offset);
  // Validate before persisting, including caller-supplied IDs and aliases.
  parseDataPack(output);
  return output;
}

function dataPackResource(pack, id) {
  const entry = pack.entries.find(entry => entry.id === id);
  if (entry) return entry;
  const alias = pack.aliases.find(alias => alias.id === id);
  return alias ? pack.entries[alias.index] : undefined;
}

function replaceProductText(text, { attribution = false } = {}) {
  if (/The Chromium Authors|Copyright|copyright/.test(text)) return text;
  if (attribution) {
    // The product is Peregrine, but its linked upstream project is Chromium.
    // The ungoogled runtime supplies a nonfunctional placeholder for $1.
    // Repair only this About license message's project href. Other upstream
    // URL substitutions, all anchor labels/attributes and $2 credits remain.
    const fixedProjectLink = text.replace(/(<a\b[^>]*\bhref=)(["'])(?:\$1|https:\/\/www\.ch40m1um\.qjz9zk\/)\2/i, (match, prefix, quote) => `${prefix}${quote}https://www.chromium.org/${quote}`);
    return fixedProjectLink.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
      .map((part, i) => i % 2 === 1 ? part : replaceProductText(part))
      .join('');
  }
  // HTML tags, link attributes, literal web URLs and code names stay intact.
  return text.split(/(<[^>]*>|(?:https?|chrome):\/\/[^\s<>"']+)/g)
    .map((part, i) => i % 2 === 1 ? part : part.replace(/\bChromium|क्रोमियम/g, PRODUCT_NAME))
    .join('');
}

function patchLocalePack(input) {
  const pack = parseDataPack(input);
  if (pack.encoding !== 1 && pack.encoding !== 2) throw new Error('Expected a localized text DataPack');
  const encoding = pack.encoding === 2 ? 'utf16le' : 'utf8';
  const brand = dataPackResource(pack, 101);
  const title = dataPackResource(pack, 475);
  if (!brand || !title || brand.data.toString(encoding) !== 'Chromium' || !/Chromium|क्रोमियम/.test(title.data.toString(encoding))) {
    throw new Error('Unsupported Chromium product-name resource layout');
  }
  const changes = [];
  for (const entry of pack.entries) {
    if (entry.id === 949 || entry.id === 950) continue;
    const before = entry.data.toString(encoding);
    const after = replaceProductText(before, { attribution: entry.id === 34399 });
    if (before !== after) {
      entry.data = Buffer.from(after, encoding);
      changes.push(entry.id);
    }
  }
  return { data: writeDataPack(pack), changes, resourceCount: pack.entries.length, aliasCount: pack.aliases.length };
}

function getPeSections(input) {
  return PE.NtExecutable.from(input).getAllSections().map(section => ({
    name: section.info.name,
    virtualAddress: section.info.virtualAddress,
    characteristics: section.info.characteristics,
    size: section.data ? section.data.byteLength : 0,
    sha256: hash(section.data ? Buffer.from(section.data) : Buffer.alloc(0)),
  }));
}

function patchPeResources(input, iconInput, filename) {
  const beforeSections = getPeSections(input);
  const executable = PE.NtExecutable.from(input);
  const resource = PE.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(iconInput);
  const iconGroups = [];
  // Only the actual browser product icons: retain incognito, file-type and
  // status/permission icon groups with their original semantics.
  const groupIds = filename === 'chrome.dll' ? [101] : filename === 'chrome.exe' ? ['IDR_MAINFRAME', 'IDR_X001_APP_LIST'] : [];
  const groups = resource.entries.filter(entry => entry.type === 14 && groupIds.includes(entry.id));
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, iconFile.icons.map(icon => icon.data));
    iconGroups.push({ id: group.id, lang: group.lang });
  }
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
  if (versions.length === 0) throw new Error(`Missing PE version resource in ${filename}`);
  for (const version of versions) {
    for (const lang of version.getAllLanguagesForStringValues()) {
      version.setStringValues(lang, { FileDescription: PRODUCT_NAME, ProductName: PRODUCT_NAME, ProductShortName: PRODUCT_NAME });
    }
    version.outputToResourceEntries(resource.entries);
  }
  resource.outputResource(executable);
  const output = Buffer.from(executable.generate());
  const afterSections = getPeSections(output);
  const nonResourceSections = beforeSections.filter(section => section.name !== '.rsrc').map(before => {
    const after = afterSections.find(section => section.name === before.name);
    if (!after || before.sha256 !== after.sha256 || before.characteristics !== after.characteristics || (before.name !== '.reloc' && before.virtualAddress !== after.virtualAddress)) {
      throw new Error(`Branding changed non-resource PE section ${filename}:${before.name}`);
    }
    return { ...before, brandedVirtualAddress: after.virtualAddress, unchanged: true };
  });
  return { data: output, originalSha256: hash(input), brandedSha256: hash(output), iconGroups, nonResourceSections };
}

function patchProductArtwork(input, iconInput, aboutOptions = {}) {
  const pack = parseDataPack(input);
  const icon = ResEdit.Data.IconFile.from(iconInput);
  const pngs = new Map(icon.icons.filter(item => item.data.isRaw()).map(item => [item.data.width, Buffer.from(item.data.bin)]));
  const largest = pngs.get(256);
  if (!largest) throw new Error('Brand icon requires a 256px PNG');
  const productSvg = size => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><image width="${size}" height="${size}" xlink:href="data:image/png;base64,${pngs.get(size).toString('base64')}"/></svg>`);
  // Resource IDs for upstream 150.0.7871.186's product art. Match dimensions
  // and SVG signatures before replacing, so an upstream layout change fails.
  const targets = new Map([[15151, 128], [15152, 256], [15187, 16], [15188, 24], [15189, 64], [15154, 'svg256'], [15155, 'svg256'], [50906, 'svg24']]);
  const changes = [];
  for (const [id, dimension] of targets) {
    const entry = dataPackResource(pack, id);
    if (!entry) throw new Error(`Missing upstream product artwork ${id}`);
    const compressed = entry.data[0] === 0x1f && entry.data[1] === 0x8b;
    const original = compressed ? zlib.gunzipSync(entry.data) : entry.data;
    let replacement;
    if (typeof dimension === 'string' && dimension.startsWith('svg')) {
      if (!original.toString('utf8').includes('<svg')) throw new Error(`Unexpected product SVG ${id}`);
      if (id === 50906 && hash(original) !== '645cb404797b48575d6ea3fa92ce3d9c872ca86c73ab9e142cb6bd2e81ff718e') throw new Error('Unexpected dark-mode settings product logo');
      replacement = productSvg(Number(dimension.slice(3)));
    } else {
      if (original.length < 24 || original.readUInt32BE(0) !== 0x89504e47 || original.readUInt32BE(16) !== dimension || original.readUInt32BE(20) !== dimension) throw new Error(`Unexpected product PNG ${id}`);
      replacement = pngs.get(dimension);
      if (!replacement) throw new Error(`Brand icon missing ${dimension}px PNG`);
    }
    entry.data = compressed ? zlib.gzipSync(replacement, { mtime: 0 }) : replacement;
    changes.push(id);
  }
  // One upstream settings component contains a literal product label rather
  // than a localized string. Do not rewrite its executable JS or identifiers.
  const settingsComponent = dataPackResource(pack, 40882);
  if (settingsComponent) {
    const compressed = settingsComponent.data[0] === 0x1f && settingsComponent.data[1] === 0x8b;
    const original = compressed ? zlib.gunzipSync(settingsComponent.data) : settingsComponent.data;
    const before = original.toString('utf8');
    const after = before.replace('Your changes will take effect the next time you relaunch Chromium.', `Your changes will take effect the next time you relaunch ${PRODUCT_NAME}.`);
    if (after !== before) {
      settingsComponent.data = compressed ? zlib.gzipSync(Buffer.from(after), { mtime: 0 }) : Buffer.from(after);
      changes.push(40882);
    }
  }
  // The cr:chrome-product icon is also used in the About navigation item.
  // Chromium bundles the identical static SVG in multiple WebUI resources.
  // Replace only that product glyph in each known copy; keep its identifier,
  // viewBox, surrounding JavaScript, handlers and upstream notices unchanged.
  const glyphCopies = [703, 17763, 19413, 19471, 19704, 19802, 20524, 20637, 20831, 21051, 21682, 21790, 21998, 22931, 22942, 23153, 23428, 50697];
  const glyphPattern = /<g id="chrome-product" viewBox="0 -960 960 960">[\s\S]*?<\/g>/g;
  const replacementGlyph = `<g id="chrome-product" viewBox="0 -960 960 960"><image x="0" y="-960" width="960" height="960" href="data:image/png;base64,${pngs.get(24).toString('base64')}"/></g>`;
  for (const id of glyphCopies) {
    const entry = dataPackResource(pack, id);
    if (!entry) throw new Error(`Missing native product iconset resource ${id}`);
    const compressed = entry.data[0] === 0x1f && entry.data[1] === 0x8b;
    const original = compressed ? zlib.gunzipSync(entry.data) : entry.data;
    const before = original.toString('utf8');
    const glyphs = before.match(glyphPattern) || [];
    if (glyphs.length !== 1 || !glyphs[0].includes('M336-479q0 60 42 102')) throw new Error(`Unexpected native product glyph layout ${id}`);
    const after = before.replace(glyphPattern, replacementGlyph);
    entry.data = compressed ? zlib.gzipSync(Buffer.from(after), { mtime: 0 }) : Buffer.from(after);
    changes.push(id);
  }
  const aboutBundle = dataPackResource(pack, 21996);
  if (!aboutBundle) throw new Error('Missing native About page resource');
  const aboutCompressed = aboutBundle.data[0] === 0x1f && aboutBundle.data[1] === 0x8b;
  const aboutOriginal = aboutCompressed ? zlib.gunzipSync(aboutBundle.data) : aboutBundle.data;
  const about = patchNativeAboutTemplate(aboutOriginal, aboutOptions);
  aboutBundle.data = aboutCompressed ? zlib.gzipSync(about.data, { mtime: 0 }) : about.data;
  changes.push(21996);
  return { data: writeDataPack(pack), changes };
}

function patchScaledProductArtwork(input, iconInput, scale) {
  if (scale !== 1 && scale !== 2) throw new Error('Unsupported product logo scale');
  const pack = parseDataPack(input);
  const icon = ResEdit.Data.IconFile.from(iconInput);
  const pngs = new Map(icon.icons.filter(item => item.data.isRaw()).map(item => [item.data.width, Buffer.from(item.data.bin)]));
  const changes = [];
  // current-channel-logo resolves to IDR_PRODUCT_LOGO_32 (15315). Settings
  // and About select the 100%/200% DataPack matching the native display scale.
  for (const [id, logicalSize] of [[15315, 32], [15317, 16]]) {
    const entry = dataPackResource(pack, id);
    const size = logicalSize * scale;
    if (!entry || entry.data.length < 24 || entry.data.readUInt32BE(0) !== 0x89504e47 || entry.data.readUInt32BE(16) !== size || entry.data.readUInt32BE(20) !== size) throw new Error(`Unexpected scaled product logo ${id}@${scale}x`);
    const replacement = pngs.get(size);
    if (!replacement) throw new Error(`Brand icon missing ${size}px PNG`);
    entry.data = replacement;
    changes.push(id);
  }
  return { data: writeDataPack(pack), changes };
}

function stageBrandedRuntime({ sourceDir = SOURCE_RUNTIME, destinationDir = BRANDED_RUNTIME, iconPath = ICON_PATH, appVersion = readApplicationVersion() } = {}) {
  validateApplicationVersion(appVersion);
  sourceDir = fs.realpathSync(sourceDir);
  destinationDir = path.resolve(destinationDir);
  // Resolve any existing parent junction before the overlap check. A staging
  // path must never reach the original runtime through a Windows junction.
  let existingParent = destinationDir;
  while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
  destinationDir = path.join(fs.realpathSync(existingParent), path.relative(existingParent, destinationDir));
  const sourceKey = sourceDir.toLowerCase();
  const destinationKey = destinationDir.toLowerCase();
  if (sourceKey === destinationKey || sourceKey.startsWith(destinationKey + path.sep) || destinationKey.startsWith(sourceKey + path.sep)) throw new Error('Branding destination must be separate from upstream source');
  const originalExecutable = fs.readFileSync(path.join(sourceDir, 'chrome.exe'));
  const originalPeResources = PE.NtExecutableResource.from(PE.NtExecutable.from(originalExecutable));
  const coreVersion = ResEdit.Resource.VersionInfo.fromEntries(originalPeResources.entries)[0].getStringValues({ lang: 1033, codepage: 1200 }).ProductVersion;
  const icon = fs.readFileSync(iconPath);
  const manifest = {
    brandingVersion: BRANDING_VERSION,
    productName: PRODUCT_NAME,
    appVersion,
    engine: 'Chromium',
    coreVersion,
    sourceDir,
    destinationDir,
    iconSha256: hash(icon),
    upstreamExecutableSha256: hash(originalExecutable),
    sourceReferences: [
      'https://github.com/adryfish/fingerprint-chromium',
      'https://github.com/chromium/chromium',
      'https://raw.githubusercontent.com/chromium/chromium/150.0.7871.186/ui/base/resource/data_pack.cc',
      'https://raw.githubusercontent.com/chromium/chromium/150.0.7871.186/chrome/app/theme/chrome_unscaled_resources.grd',
    ],
    files: [],
  };
  // cpSync overwrites only the isolated staging directory. No original file,
  // current browser profile or already-installed runtime is changed/deleted.
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
  for (const filename of fs.readdirSync(path.join(sourceDir, 'locales')).filter(name => name.endsWith('.pak')).sort()) {
    const relative = path.join('locales', filename);
    const input = fs.readFileSync(path.join(sourceDir, relative));
    const result = patchLocalePack(input);
    fs.writeFileSync(path.join(destinationDir, relative), result.data);
    manifest.files.push({ path: relative.replace(/\\/g, '/'), originalSha256: hash(input), brandedSha256: hash(result.data), changedResourceIds: result.changes, resourceCount: result.resourceCount, aliasCount: result.aliasCount });
  }
  for (const filename of ['chrome.exe', 'chrome.dll', 'chrome_proxy.exe', 'chrome_pwa_launcher.exe']) {
    const result = patchPeResources(fs.readFileSync(path.join(sourceDir, filename)), icon, filename);
    fs.writeFileSync(path.join(destinationDir, filename), result.data);
    const { data, ...report } = result;
    manifest.files.push({ path: filename, ...report });
  }
  const artworkInput = fs.readFileSync(path.join(sourceDir, 'resources.pak'));
  const artwork = patchProductArtwork(artworkInput, icon, { appVersion, coreVersion });
  fs.writeFileSync(path.join(destinationDir, 'resources.pak'), artwork.data);
  manifest.files.push({ path: 'resources.pak', originalSha256: hash(artworkInput), brandedSha256: hash(artwork.data), changedResourceIds: artwork.changes });
  for (const scale of [1, 2]) {
    const filename = `chrome_${scale * 100}_percent.pak`;
    const input = fs.readFileSync(path.join(sourceDir, filename));
    const result = patchScaledProductArtwork(input, icon, scale);
    fs.writeFileSync(path.join(destinationDir, filename), result.data);
    manifest.files.push({ path: filename, originalSha256: hash(input), brandedSha256: hash(result.data), changedResourceIds: result.changes });
  }
  if (hash(fs.readFileSync(path.join(sourceDir, 'chrome.exe'))) !== manifest.upstreamExecutableSha256) throw new Error('Upstream executable changed during staging');
  fs.writeFileSync(path.join(destinationDir, 'brand-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (require.main === module) {
  const manifest = stageBrandedRuntime();
  console.log(`Branded ${manifest.files.length} native resource files as ${manifest.productName}: ${manifest.destinationDir}`);
}

module.exports = { PRODUCT_NAME, BRANDING_VERSION, SOURCE_RUNTIME, BRANDED_RUNTIME, ICON_PATH, readApplicationVersion, buildNativeAboutTemplate, patchNativeAboutTemplate, parseDataPack, writeDataPack, dataPackResource, replaceProductText, patchLocalePack, getPeSections, patchPeResources, patchProductArtwork, patchScaledProductArtwork, stageBrandedRuntime };
