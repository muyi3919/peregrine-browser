'use strict';

const DEVICE_MEMORY_HEADERS = Object.freeze(['device-memory', 'sec-ch-device-memory']);
const FINGERPRINT_REQUEST_PATTERNS = Object.freeze([
  Object.freeze({ urlPattern: 'http://*', requestStage: 'Request' }),
  Object.freeze({ urlPattern: 'https://*', requestStage: 'Request' }),
]);

/**
 * Use at CDP Fetch.requestPaused, before Fetch.continueRequest. The browser
 * decides whether an origin is eligible for Client Hints; we only replace
 * memory hints it has already generated. An absent hint stays absent.
 *
 * Chrome 150 DNR RuleCondition has responseHeaders, not requestHeaders, so
 * DNR cannot implement this request-header presence check:
 * https://github.com/chromium/chromium/blob/150.0.7871.186/extensions/common/api/declarative_net_request.webidl
 *
 * CDP overrides apply to one request, not subsequent redirect hops. Enable
 * Request-stage interception for HTTP/HTTPS in page and iframe sessions,
 * before resuming their first script, and apply this on every hop. The shipped
 * Chromium 150 Worker targets do not expose Fetch.enable; dedicated, shared
 * and service Worker controls omit both memory hints. Keep that native absence
 * rather than adding unsolicited headers. Recheck Worker behavior on upgrades.
 */
function rewriteDeviceMemoryRequestHeaders(requestHeaders, memoryGiB = 8) {
  if (![4, 8].includes(memoryGiB)) throw new TypeError('Fingerprint memory must be 4 or 8 GiB.');
  if (!requestHeaders || typeof requestHeaders !== 'object') return undefined;
  const entries = Array.isArray(requestHeaders)
    ? requestHeaders.map(entry => ({ name: entry.name, value: entry.value }))
    : Object.entries(requestHeaders).map(([name, value]) => ({ name, value }));
  const isMemory = name => typeof name === 'string' && DEVICE_MEMORY_HEADERS.includes(name.toLowerCase());
  if (!entries.some(entry => isMemory(entry.name))) return undefined;
  return entries.map(({ name, value }) => ({ name, value: isMemory(name) ? String(memoryGiB) : String(value) }));
}

module.exports = { DEVICE_MEMORY_HEADERS, FINGERPRINT_REQUEST_PATTERNS, rewriteDeviceMemoryRequestHeaders };
