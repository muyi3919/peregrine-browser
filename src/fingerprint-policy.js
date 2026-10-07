'use strict';

const CORE_VERSION = '150.0.7871.186';
const SEARCH_ENGINES = Object.freeze({
  bing: { name: 'Microsoft Bing', keyword: 'bing.com', url: 'https://www.bing.com/search?q={searchTerms}', id: 3 },
  google: { name: 'Google', keyword: 'google.com', url: 'https://www.google.com/search?q={searchTerms}', id: 1 },
  duckduckgo: { name: 'DuckDuckGo', keyword: 'duckduckgo.com', url: 'https://duckduckgo.com/?q={searchTerms}', id: 92 },
  baidu: { name: '百度', keyword: 'baidu.com', url: 'https://www.baidu.com/s?wd={searchTerms}', id: 21 }
});
const SCREENS = [[1366, 768], [1536, 864], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];

function defaultScreen(seed, width = 1280, height = 900) {
  const choices = SCREENS.filter(([w, h]) => w >= width && h >= height);
  const [screenWidth, screenHeight] = (choices.length ? choices : SCREENS.slice(-1))[(seed >>> 0) % (choices.length || 1)];
  return { screenWidth, screenHeight, pixelRatio: 1 };
}

function userAgentOverride(profile) {
  const ua = profile.userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CORE_VERSION.split('.')[0]}.0.0.0 Safari/537.36`;
  const versionMatch = ua.match(/(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/);
  let platform = 'Win32', uaPlatform = 'Windows', platformVersion = '10.0.0', architecture = 'x86', bitness = '64', mobile = false, model = '';
  if (/Android/i.test(ua)) { platform = 'Linux armv8l'; uaPlatform = 'Android'; platformVersion = ua.match(/Android\s+(\d+(?:\.\d+)*)/)?.[1] || ''; architecture = 'arm'; mobile = /Mobile/i.test(ua); }
  else if (/Macintosh|Mac OS X/i.test(ua)) { platform = 'MacIntel'; uaPlatform = 'macOS'; platformVersion = (ua.match(/Mac OS X\s+(\d+(?:_\d+)*)/)?.[1] || '').replaceAll('_', '.'); }
  else if (/Linux|X11/i.test(ua)) { platform = 'Linux x86_64'; uaPlatform = 'Linux'; platformVersion = ''; }
  const supplied = Boolean(profile.userAgent);
  const version = versionMatch ? (supplied ? versionMatch[1].split('.').concat(['0', '0', '0']).slice(0, 4).join('.') : CORE_VERSION) : '';
  const brands = versionMatch ? [{ brand: 'Chromium', version: version.split('.')[0] }, { brand: 'Google Chrome', version: version.split('.')[0] }, { brand: 'Not_A Brand', version: '24' }] : [];
  const fullVersionList = brands.map(item => ({ brand: item.brand, version: item.brand === 'Not_A Brand' ? '24.0.0.0' : version }));
  return {
    userAgent: ua, acceptLanguage: `${profile.locale || 'en-US'},${(profile.locale || 'en-US').split('-')[0]}`, platform,
    ...(versionMatch ? { userAgentMetadata: { brands, fullVersionList, fullVersion: version, platform: uaPlatform, platformVersion, architecture, bitness, model, mobile, wow64: false } } : {})
  };
}

function installDevicePolicy(settings) {
  const nav = globalThis.navigator;
  if (!nav) return;
  const proto = Object.getPrototypeOf(nav);
  const marker = Symbol.for('peregrine-device-policy-v1');
  if (proto[marker]) return;
  // Explicit, auditable properties. No Function.toString disguise.
  const values = { hardwareConcurrency: settings.hardwareConcurrency, platform: settings.platform };
  if ('deviceMemory' in proto) values.deviceMemory = settings.memoryGiB;
  if (settings.suppressClientHints && 'userAgentData' in proto) values.userAgentData = undefined;
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(proto, key);
    if (original && original.configurable) Object.defineProperty(proto, key, { ...original, get() { original.get?.call(this); return value; } });
  }
  Object.defineProperty(proto, marker, { value: true });
}

function buildDevicePolicySource(profile) {
  const override=userAgentOverride(profile);
  return `(${installDevicePolicy.toString()})(${JSON.stringify({ hardwareConcurrency: profile.hardwareConcurrency || 8, memoryGiB: profile.memoryGiB || 8, platform: override.platform, suppressClientHints: !override.userAgentMetadata })});`;
}

function searchUrl(value, engine = 'bing') {
  return SEARCH_ENGINES[engine].url.replace('{searchTerms}', encodeURIComponent(value));
}

module.exports = { CORE_VERSION, SEARCH_ENGINES, defaultScreen, userAgentOverride, buildDevicePolicySource, searchUrl };
