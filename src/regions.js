'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { defaultScreen, SEARCH_ENGINES } = require('./fingerprint-policy');
const HOME_URL = 'peregrine://home/';
const SECURITY_DEFAULTS = Object.freeze({ webrtc: 'proxy', httpsOnly: true, blockThirdPartyCookies: true, camera: 'block', microphone: 'block', notifications: 'block' });

const regions = [
  ['jp-tokyo', '日本', 'JP', '东京', '🇯🇵', 'ja-JP', 'Asia/Tokyo', 35.6762, 139.6503],
  ['jp-osaka', '日本', 'JP', '大阪', '🇯🇵', 'ja-JP', 'Asia/Tokyo', 34.6937, 135.5023],
  ['tw-taipei', '中国台湾', 'TW', '台北', '🇹🇼', 'zh-TW', 'Asia/Taipei', 25.0330, 121.5654],
  ['hk-hongkong', '中国香港', 'HK', '香港', '🇭🇰', 'zh-HK', 'Asia/Hong_Kong', 22.3193, 114.1694],
  ['sg-singapore', '新加坡', 'SG', '新加坡', '🇸🇬', 'en-SG', 'Asia/Singapore', 1.3521, 103.8198],
  ['kr-seoul', '韩国', 'KR', '首尔', '🇰🇷', 'ko-KR', 'Asia/Seoul', 37.5665, 126.9780],
  ['us-newyork', '美国', 'US', '纽约', '🇺🇸', 'en-US', 'America/New_York', 40.7128, -74.0060],
  ['us-losangeles', '美国', 'US', '洛杉矶', '🇺🇸', 'en-US', 'America/Los_Angeles', 34.0522, -118.2437],
  ['gb-london', '英国', 'GB', '伦敦', '🇬🇧', 'en-GB', 'Europe/London', 51.5074, -0.1278],
  ['de-berlin', '德国', 'DE', '柏林', '🇩🇪', 'de-DE', 'Europe/Berlin', 52.5200, 13.4050],
  ['fr-paris', '法国', 'FR', '巴黎', '🇫🇷', 'fr-FR', 'Europe/Paris', 48.8566, 2.3522],
  ['ca-toronto', '加拿大', 'CA', '多伦多', '🇨🇦', 'en-CA', 'America/Toronto', 43.6532, -79.3832],
  ['au-sydney', '澳大利亚', 'AU', '悉尼', '🇦🇺', 'en-AU', 'Australia/Sydney', -33.8688, 151.2093],
  ['cn-shanghai', '中国大陆', 'CN', '上海', '🇨🇳', 'zh-CN', 'Asia/Shanghai', 31.2304, 121.4737]
].map(([id, country, countryCode, city, flag, locale, timezone, latitude, longitude]) =>
  Object.freeze({ id, country, countryCode, city, flag, locale, timezone, latitude, longitude }));

function validateProfile(input, existing, nodeIds = []) {
  if (!input || typeof input !== 'object') throw new Error('环境设置格式不正确。');
  const region = regions.find(r => r.id === input.regionId);
  if (!region) throw new Error('请选择国家与城市。');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('环境名称需要 1–80 个字符。');
  const locale = String(input.locale || region.locale).trim();
  try { if (Intl.getCanonicalLocales(locale).length !== 1) throw new Error(); }
  catch { throw new Error('语言代码格式不正确，例如 ja-JP 或 en-US。'); }
  const timezone = String(input.timezone || region.timezone).trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('时区无效，请使用 Asia/Tokyo 等 IANA 时区名称。'); }
  const latitude = Number(input.latitude ?? region.latitude);
  const longitude = Number(input.longitude ?? region.longitude);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new Error('定位经纬度超出有效范围。');
  const locationMode = input.locationMode || 'ask';
  if (!['ask', 'allow', 'block'].includes(locationMode)) throw new Error('定位授权设置无效。');
  const nodeId = String(input.nodeId || '');
  if (nodeId && !nodeIds.includes(nodeId)) throw new Error('所选节点不存在，请重新选择。');
  const userAgent = String(input.userAgent || '').trim();
  if (userAgent.length > 2048 || /[\u0000-\u001f\u007f]/.test(userAgent)) throw new Error('UA 长度须不超过 2048 个字符，且不能包含换行或控制字符。');
  const homepage = normalizeUrl(String(input.homepage || HOME_URL));
  const engine = input.engine || existing?.engine || (existing ? 'electron' : 'fingerprint');
  if (!['electron', 'fingerprint'].includes(engine)) throw new Error('浏览器内核选择无效。');
  const fingerprintSeed = input.fingerprintSeed === undefined || input.fingerprintSeed === ''
    ? (existing?.fingerprintSeed ?? (existing?.id ? createHash('sha256').update(existing.id).digest().readUInt32LE(0) : randomBytes(4).readUInt32LE(0)))
    : Number(input.fingerprintSeed);
  if (!Number.isInteger(fingerprintSeed) || fingerprintSeed < 0 || fingerprintSeed > 4294967295) throw new Error('指纹种子须为 0–4294967295 的整数。');
  const hardwareConcurrency = Number(input.hardwareConcurrency ?? existing?.hardwareConcurrency ?? 8);
  if (![4, 8, 12, 16].includes(hardwareConcurrency)) throw new Error('逻辑处理器数量须为 4、8、12 或 16。');
  const canvasMode = input.canvasMode ?? existing?.canvasMode ?? 'stable';
  if (!['stable', 'compatibility', 'native'].includes(canvasMode)) throw new Error('Canvas 模式无效。');
  const security = { ...SECURITY_DEFAULTS, ...existing?.security, ...input.security };
  if (!['proxy', 'block'].includes(security.webrtc) || ['camera', 'microphone', 'notifications'].some(key => !['ask', 'block'].includes(security[key])) || ['httpsOnly', 'blockThirdPartyCookies'].some(key => typeof security[key] !== 'boolean')) throw new Error('安全选项格式不正确。');
  const width = Number(input.width || 1280), height = Number(input.height || 900);
  if (!Number.isInteger(width) || width < 800 || width > 3840 || !Number.isInteger(height) || height < 600 || height > 2160)
    throw new Error('窗口大小须在 800–3840 × 600–2160 范围内。');
  const screenDefaults = defaultScreen(fingerprintSeed, width, height);
  const screenWidth = Number(input.screenWidth ?? existing?.screenWidth ?? screenDefaults.screenWidth);
  const screenHeight = Number(input.screenHeight ?? existing?.screenHeight ?? screenDefaults.screenHeight);
  const pixelRatio = Number(input.pixelRatio ?? existing?.pixelRatio ?? 1);
  if (!Number.isInteger(screenWidth) || screenWidth < 800 || screenWidth > 7680 || !Number.isInteger(screenHeight) || screenHeight < 600 || screenHeight > 4320 || ![1, 1.25, 1.5, 2].includes(pixelRatio)) throw new Error('虚拟屏幕或像素比例无效。');
  const memoryGiB = Number(input.memoryGiB ?? existing?.memoryGiB ?? 8);
  if (![4, 8].includes(memoryGiB)) throw new Error('网站可见内存请选择 4 或 8 GB。');
  const searchEngine = input.searchEngine ?? existing?.searchEngine ?? 'bing';
  if (!Object.hasOwn(SEARCH_ENGINES, searchEngine)) throw new Error('搜索引擎无效。');
  return {
    id: existing?.id || require('node:crypto').randomUUID(), name, regionId: region.id, locale, timezone,
    latitude, longitude, locationMode, nodeId, userAgent, homepage, width, height,
    engine, fingerprintSeed, hardwareConcurrency, canvasMode, security,
    memoryGiB, screenWidth, screenHeight, pixelRatio, searchEngine, fingerprintVersion: 1,
    notes: String(input.notes || '').slice(0, 2000), createdAt: existing?.createdAt || new Date().toISOString()
  };
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (trimmed === 'about:blank') return trimmed;
  if (trimmed === HOME_URL) return HOME_URL;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try { url = new URL(candidate); } catch { throw new Error('请输入有效的网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('仅支持不含用户名和密码的 HTTP 或 HTTPS 网页地址。');
  return url.href;
}

module.exports = { regions, validateProfile, normalizeUrl, HOME_URL, SECURITY_DEFAULTS };
