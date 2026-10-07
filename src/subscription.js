'use strict';

const YAML = require('yaml');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PROXIES = 3000;
const FETCH_TIMEOUT_MS = 15000;
const RESERVED = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
const SUPPORTED_TYPES = new Set([
  'ss', 'ssr', 'socks5', 'http', 'vmess', 'vless', 'trojan', 'snell',
  'hysteria', 'hysteria2', 'tuic', 'wireguard', 'anytls', 'mieru', 'sudoku',
]);
const INVALID_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Do not put parser diagnostics or values in an error: they may contain passwords.
function cloneValue(value, depth = 0, state = { count: 0 }) {
  if (depth > 14 || ++state.count > 150000) throw new Error('订阅节点结构过于复杂。');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 65536) return value;
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('订阅节点列表过长。');
    return value.map(item => cloneValue(item, depth + 1, state));
  }
  if (isRecord(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (INVALID_KEYS.has(key) || key.length > 128) throw new Error('订阅包含不安全的结构字段。');
      result[key] = cloneValue(item, depth + 1, state);
    }
    return result;
  }
  throw new Error('订阅节点包含无效数据。');
}

function validateProxies(proxies) {
  if (!Array.isArray(proxies) || proxies.length === 0) throw new Error('订阅需要包含非空的 proxies 节点列表。');
  if (proxies.length > MAX_PROXIES) throw new Error('订阅节点过多，最多支持 3000 个节点。');
  const names = new Set();
  const state = { count: 0 };
  return proxies.map(raw => {
    if (!isRecord(raw)) throw new Error('订阅节点必须是对象。');
    const proxy = cloneValue(raw, 0, state);
    if (typeof proxy.name !== 'string' || !proxy.name.trim() || proxy.name.length > 256
      || /[\u0000-\u001f\u007f]/u.test(proxy.name)) throw new Error('节点名称缺失或不合法。');
    if (RESERVED.has(proxy.name.toUpperCase())) throw new Error('节点不能使用保留的直连或系统策略名称。');
    if (names.has(proxy.name)) throw new Error('订阅包含重复的节点名称，请先在订阅端修改。');
    names.add(proxy.name);
    if (typeof proxy.type !== 'string' || !SUPPORTED_TYPES.has(proxy.type.toLowerCase())) {
      throw new Error('订阅包含当前版本不支持的节点协议。支持 SS、SSR、VMess、VLESS、Trojan、HTTP、SOCKS5、Snell、Hysteria、Hysteria2、TUIC、WireGuard、AnyTLS、Mieru 和 Sudoku。');
    }
    proxy.type = proxy.type.toLowerCase();
    if (typeof proxy.server !== 'string' || !proxy.server.trim() || proxy.server.length > 512
      || /[\s\u0000-\u001f\u007f/\\]/u.test(proxy.server)) throw new Error('节点服务器地址无效。');
    if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) throw new Error('节点端口必须是 1 到 65535 的整数。');
    if (proxy['dialer-proxy'] !== undefined && (typeof proxy['dialer-proxy'] !== 'string'
      || !proxy['dialer-proxy'].trim() || proxy['dialer-proxy'].length > 256)) {
      throw new Error('节点的 dialer-proxy 引用无效。');
    }
    return proxy;
  });
}

function parseSubscription(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('订阅内容过大，最大支持 5 MB。');
  let document;
  let config;
  try {
    document = YAML.parseDocument(text, { uniqueKeys: true, prettyErrors: false, strict: true, schema: 'core' });
    if (document.errors.length || document.warnings.length) throw new Error('invalid yaml');
    config = document.toJS({ maxAliasCount: 20 });
  } catch {
    throw new Error('无法解析 Clash YAML 订阅，请检查格式。');
  }
  if (!isRecord(config)) throw new Error('需要 Clash YAML 格式订阅，且包含 proxies 节点列表。');
  if ((!Array.isArray(config.proxies) || config.proxies.length === 0) && config['proxy-providers']) {
    throw new Error('这是仅包含 proxy-providers 的配置，请提供直接包含 proxies 节点列表的 Clash 订阅。');
  }
  // Only this list is returned. Rules, scripts, providers and file paths at the
  // configuration level never reach the proxy process.
  return validateProxies(config.proxies);
}

async function fetchSubscription(value) {
  let url;
  try {
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('bad url');
  } catch {
    throw new Error('请输入有效的 HTTP 或 HTTPS 订阅链接。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    // In the desktop application use Chromium networking so a user's existing
    // Windows system proxy can download the subscription before a core starts.
    const fetcher = process.versions.electron ? require('electron').net.fetch.bind(require('electron').net) : fetch;
    response = await fetcher(url.href, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit',
      ...(process.versions.electron ? { bypassCustomProtocolHandlers: true } : {}),
      headers: { 'User-Agent': 'ClashMeta/1.19.32 PeregrineBrowser/0.1', Accept: 'text/yaml, application/yaml, text/plain, */*' },
    });
    if (!response.ok) throw new Error(`订阅服务器返回 HTTP ${response.status}。`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('订阅内容过大，最大支持 5 MB。');
    if (!response.body) throw new Error('订阅服务器未返回内容。');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        controller.abort();
        throw new Error('订阅内容过大，最大支持 5 MB。');
      }
      chunks.push(chunk);
    }
    const proxies = parseSubscription(Buffer.concat(chunks).toString('utf8'));
    return { proxies, host: url.hostname };
  } catch (error) {
    // Preserve only our known errors, never a fetch error containing the URL.
    if (error instanceof Error && /^(订阅|无法解析|需要 Clash|这是仅|节点)/u.test(error.message)) throw error;
    if (controller.signal.aborted) throw new Error('订阅下载超时，请检查网络连接。');
    throw new Error('订阅下载失败，请检查链接和网络连接。');
  } finally {
    clearTimeout(timeout);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

const COUNTRY_HINTS = [
  ['HK', /🇭🇰|香港|hong[ -]?kong|\bhk\b/iu],
  ['TW', /🇹🇼|台湾|台灣|taiwan|\btw\b/iu],
  ['JP', /🇯🇵|日本|东京|東京|大阪|japan|tokyo|osaka|\bjp\b/iu],
  ['SG', /🇸🇬|新加坡|狮城|獅城|singapore|\bsg\b/iu],
  ['US', /🇺🇸|美国|美國|洛杉矶|洛杉磯|纽约|紐約|united[ -]?states|america|los[ -]?angeles|new[ -]?york|\busa?\b/iu],
  ['GB', /🇬🇧|英国|英國|伦敦|倫敦|united[ -]?kingdom|britain|london|\buk\b|\bgb\b/iu],
  ['DE', /🇩🇪|德国|德國|法兰克福|法蘭克福|germany|frankfurt|\bde\b/iu],
  ['KR', /🇰🇷|韩国|韓國|首尔|首爾|korea|seoul|\bkr\b/iu],
  ['CA', /🇨🇦|加拿大|canada|\bca\b/iu],
  ['AU', /🇦🇺|澳大利亚|澳大利亞|澳洲|australia|sydney|\bau\b/iu],
  ['FR', /🇫🇷|法国|法國|france|paris|\bfr\b/iu],
  ['NL', /🇳🇱|荷兰|荷蘭|netherlands|amsterdam|\bnl\b/iu],
  ['RU', /🇷🇺|俄罗斯|俄羅斯|russia|moscow|\bru\b/iu],
  ['IN', /🇮🇳|印度|india|\bin\b/iu],
  ['CN', /🇨🇳|中国|中國|大陆|大陸|china|\bcn\b/iu],
];

function guessCountry(name) {
  if (typeof name !== 'string') return '';
  return COUNTRY_HINTS.find(([, expression]) => expression.test(name))?.[0] || '';
}

module.exports = { fetchSubscription, parseSubscription, guessCountry, validateProxies, MAX_BYTES };
