'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { NativeHost } = require('../src/native-host');
const { DEVICE_MEMORY_HEADERS, FINGERPRINT_REQUEST_PATTERNS, rewriteDeviceMemoryRequestHeaders } = require('../src/fingerprint-headers');
const binaryPath = path.resolve(__dirname, '../vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64/chrome.exe');

test('memory header rewriting preserves existing entries, casing and absence without mutating its input', () => {
  const input = { 'Device-Memory': '16', 'Sec-CH-Device-Memory': '16', Cookie: 'syntheticCookie=1', Authorization: 'synthetic-authorization', 'Accept-Language': 'ja-JP,ja;q=0.9' };
  const result = rewriteDeviceMemoryRequestHeaders(input, 4);
  assert.deepEqual(result, [
    { name: 'Device-Memory', value: '4' }, { name: 'Sec-CH-Device-Memory', value: '4' },
    { name: 'Cookie', value: 'syntheticCookie=1' }, { name: 'Authorization', value: 'synthetic-authorization' }, { name: 'Accept-Language', value: 'ja-JP,ja;q=0.9' },
  ]);
  assert.equal(input['Device-Memory'], '16');
  const duplicates = [{ name: 'device-memory', value: '16' }, { name: 'DEVICE-MEMORY', value: '16' }, { name: 'x-test', value: 'unchanged' }];
  assert.deepEqual(rewriteDeviceMemoryRequestHeaders(duplicates, 8), [{ name: 'device-memory', value: '8' }, { name: 'DEVICE-MEMORY', value: '8' }, { name: 'x-test', value: 'unchanged' }]);
  assert.equal(duplicates[0].value, '16');
  assert.deepEqual(rewriteDeviceMemoryRequestHeaders({ 'sec-ch-device-memory': '16' }, 4), [{ name: 'sec-ch-device-memory', value: '4' }], 'does not add the other missing hint');
  for (const value of [undefined, null, {}, { 'sec-ch-ua': 'Chromium' }]) assert.equal(rewriteDeviceMemoryRequestHeaders(value, 4), undefined);
  for (const memory of [0, 16, '4', NaN]) assert.throws(() => rewriteDeviceMemoryRequestHeaders(input, memory), /4 or 8/);
  assert.deepEqual(DEVICE_MEMORY_HEADERS, ['device-memory', 'sec-ch-device-memory']);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(host, url) {
  await host.navigate(url);
  for (let count = 0; count < 100; count++) { if (await host.evaluate('document.readyState') === 'complete') return; await delay(20); }
  throw new Error('Memory fixture did not load');
}
function assertMemory(headers, memory) {
  for (const name of DEVICE_MEMORY_HEADERS) assert.equal(headers[name], String(memory), `${name} equals profile-visible JS memory`);
}
function assertWorkerMemory(headers, memory) {
  // Passthrough controls on Chromium 150 omit both hints in all three worker
  // kinds. Preserve this behavior; if a future core emits one, it must match.
  for (const name of DEVICE_MEMORY_HEADERS) {
    if (headers[name] !== undefined) assert.equal(headers[name], String(memory), `${name} equals profile-visible JS memory`);
  }
}
const workerScripts = {
  '/dedicated.js': "const first=navigator.deviceMemory;fetch('/headers').then(r=>r.json()).then(headers=>postMessage({first,memory:navigator.deviceMemory,headers}));",
  '/shared.js': "const first=navigator.deviceMemory;onconnect=e=>fetch('/headers').then(r=>r.json()).then(headers=>e.ports[0].postMessage({first,memory:navigator.deviceMemory,headers}));",
  '/service.js': "const first=navigator.deviceMemory;self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch('/headers').then(r=>r.json()).then(headers=>e.ports[0].postMessage({first,memory:navigator.deviceMemory,headers}))));",
};
const workerExpressions = {
  dedicated: "new Promise((resolve,reject)=>{const w=new Worker('/dedicated.js'),t=setTimeout(()=>{w.terminate();reject(Error('dedicated timeout'))},6000);w.onmessage=e=>{clearTimeout(t);w.terminate();resolve(e.data)};w.onerror=()=>{clearTimeout(t);w.terminate();reject(Error('dedicated failed'))}})",
  shared: "new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js'),t=setTimeout(()=>{w.port.close();reject(Error('shared timeout'))},6000);w.port.onmessage=e=>{clearTimeout(t);w.port.close();resolve(e.data)};w.port.start()})",
  service: "Promise.race([(async()=>{const r=await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;const data=await new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>resolve(e.data);r.active.postMessage('collect',[c.port2])});await r.unregister();return data})(),new Promise((_,reject)=>setTimeout(()=>reject(Error('service timeout')),7000))])",
};

test('real page hints match configured memory; three Worker kinds preserve native hint absence and cookies', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  await fs.access(binaryPath);
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-memory-headers-test-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/headers' }); res.end(); return; }
    const hints = req.url === '/opt-in' || req.url === '/frame' || workerScripts[req.url] ? { 'Accept-CH': 'Device-Memory, Sec-CH-Device-Memory' } : {};
    res.writeHead(200, { 'Content-Type': req.url === '/headers' ? 'application/json' : workerScripts[req.url] ? 'application/javascript' : 'text/html', 'Cache-Control': 'no-store', ...hints });
    res.end(req.url === '/headers' ? JSON.stringify(req.headers) : workerScripts[req.url] || (req.url === '/frame' ? "<!doctype html><script>fetch('/headers').then(r=>r.json()).then(headers=>parent.postMessage({memory:navigator.deviceMemory,headers},'*'));</script>" : '<!doctype html><html><body>memory fixture</body></html>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://localhost:${server.address().port}`;
  const hosts = [];
  const frameHints = [];
  try {
    for (const memoryGiB of [4, 8]) {
      const profile = { id: `memory-${memoryGiB}`, fingerprintSeed: 123456789 + memoryGiB, canvasMode: 'compatibility', hardwareConcurrency: 4, memoryGiB, locale: 'en-US', timezone: 'UTC', locationMode: 'block', homepage: 'about:blank', security: { webrtc: 'proxy', httpsOnly: false, camera: 'block', microphone: 'block', notifications: 'block' } };
      const host = new NativeHost({ profile, binaryPath, dataRoot }); hosts.push(host); await host.initialize();
      await ready(host, url + '/plain');
      const without = await host.evaluate("fetch('/headers').then(r=>r.json())");
      for (const name of DEVICE_MEMORY_HEADERS) assert.equal(without[name], undefined, `no Accept-CH: ${name} stays absent`);
      await ready(host, url + '/opt-in');
      const opted = await host.evaluate("document.cookie='memoryProof=synthetic;Path=/';fetch('/headers',{headers:{Authorization:'synthetic-test'}}).then(r=>r.json())");
      assertMemory(opted, memoryGiB); assert.equal(opted.cookie, 'memoryProof=synthetic'); assert.equal(opted.authorization, 'synthetic-test');
      assert.equal(opted['user-agent'], await host.evaluate('navigator.userAgent'));
      assert.equal(await host.evaluate('navigator.deviceMemory'), memoryGiB);
      for (const frameURL of [url + '/frame', `http://127.0.0.1:${server.address().port}/frame`]) {
        const frame = await host.evaluate(`new Promise((resolve,reject)=>{const f=document.createElement('iframe'),t=setTimeout(()=>reject(Error('frame timeout')),6000);const listener=e=>{if(e.source===f.contentWindow){clearTimeout(t);removeEventListener('message',listener);f.remove();resolve(e.data)}};addEventListener('message',listener);f.src=${JSON.stringify(frameURL)};document.body.append(f)})`);
        assert.equal(frame.memory, memoryGiB); assertWorkerMemory(frame.headers, memoryGiB);
        frameHints.push({ memoryGiB, crossOrigin: !frameURL.startsWith(url), values: DEVICE_MEMORY_HEADERS.map(name => frame.headers[name] ?? null) });
      }
      for (const [kind, expression] of Object.entries(workerExpressions)) {
        const worker = await host.evaluate(expression);
        assert.equal(worker.first, memoryGiB, `${kind}: memory is configured before first script`);
        assert.equal(worker.memory, memoryGiB); assertWorkerMemory(worker.headers, memoryGiB);
        for (const name of DEVICE_MEMORY_HEADERS) assert.equal(worker.headers[name], undefined, `${kind}: native memory hint absence retained`);
        assert.equal(worker.headers.cookie, 'memoryProof=synthetic');
      }
      const redirected = await host.evaluate("fetch('/redirect').then(r=>r.json())"); assertMemory(redirected, memoryGiB);
      for (const request of requests.filter(item => item.url === '/redirect').slice(-1)) assertMemory(request.headers, memoryGiB);
      await ready(host, url + '/plain');
      assertMemory(requests.filter(item => item.url === '/plain').at(-1).headers, memoryGiB, 'main-frame requests also use the policy');
      const cleanOrigin = await host.evaluate(`fetch('http://one.localhost:${server.address().port}/headers',{mode:'no-cors'}).then(()=>true)`); assert.equal(cleanOrigin, true);
      for (const name of DEVICE_MEMORY_HEADERS) assert.equal(requests.at(-1).headers[name], undefined, 'another origin without opt-in receives no memory hint');
      await host.close();
    }
    console.log('DeviceMemory Client Hint proof', JSON.stringify({ memoryGiB: [4, 8], pageHintsMatch: true, frameHints, workerKindsWithNativeHintAbsence: ['dedicated', 'shared', 'service'], noOptInAddsHeaders: false, cookiesPreserved: true, redirectsCovered: true }));
  } finally {
    for (const host of hosts) { if (host.lastError) console.log('Memory hint host error', host.lastError.message, host.lastError.protocolError); await host.close(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
