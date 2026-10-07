'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchSubscription, parseSubscription, guessCountry, MAX_BYTES } = require('../src/subscription');
const { ProxyEngine, buildConfig } = require('../src/proxy-engine');

const node = { name: '日本 Tokyo', type: 'http', server: '127.0.0.1', port: 23456 };

// Public test fixture only. This key is never used by the application.
const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7eASUJoF6pAZRsIc
Bt21BZ9GaXsgImkBHX37ZodVbW+hRANCAARgvtpaMdBye7nhEmI2hCWhzulhhJkb
3DjteY3lpLBeSibFG9khYr27FicHFH74cv0I0sOfJd1sPTR+dP5a9VJf
-----END PRIVATE KEY-----`;
const testCert = `-----BEGIN CERTIFICATE-----
MIIBNDCB26ADAgECAgEBMAoGCCqGSM49BAMCMBQxEjAQBgNVBAMMCWxvY2FsaG9z
dDAeFw0yMDAxMDEwMDAwMDBaFw00MDAxMDEwMDAwMDBaMBQxEjAQBgNVBAMMCWxv
Y2FsaG9zdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGC+2lox0HJ7ueESYjaE
JaHO6WGEmRvcOO15jeWksF5KJsUb2SFivbsWJwcUfvhy/QjSw58l3Ww9NH50/lr1
Ul+jHjAcMBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAKBggqhkjOPQQDAgNI
ADBFAiAJPkhc+ZNxf1kXaA+kzDWTbHXqhImEkVX3LXsazqjuUQIhAK9SrXfbarBD
ADf+1NQYHJPXWtwVxwTzDEZlkz6gjESg
-----END CERTIFICATE-----`;

async function listen(server) {
  server.testSockets = new Set();
  server.on('connection', socket => {
    server.testSockets.add(socket);
    socket.once('close', () => server.testSockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  for (const socket of server.testSockets || []) socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('YAML import returns nodes and ignores rules, providers and executable configuration', () => {
  const proxies = parseSubscription('proxies:\n  - {name: 日本, type: http, server: 127.0.0.1, port: 3128}\nrules: [MATCH,DIRECT]\nexternal-controller: 0.0.0.0:9090\nproxy-providers:\n  evil: {type: file, path: C:/secret}\nscript: {code: dangerous}\n');
  assert.equal(proxies.length, 1);
  assert.equal(proxies[0].name, '日本');
  assert.equal(proxies[0].rules, undefined);
});

test('provider-only, duplicate names, invalid structures and oversized content are rejected', () => {
  assert.throws(() => parseSubscription('proxy-providers: {remote: {type: http, url: https://invalid.example}}'), /proxy-providers/u);
  assert.throws(() => parseSubscription('proxies: [{name: same, type: http, server: a, port: 80}, {name: same, type: http, server: b, port: 80}]'), /重复/u);
  assert.throws(() => parseSubscription('proxies: [{name: DIRECT, type: direct}]'), /保留/u);
  assert.throws(() => parseSubscription('proxies: [{name: bad, type: http, server: a, port: -1}]'), /端口/u);
  assert.throws(() => parseSubscription('proxies: [{name: bad, type: http, server: a, port: 80, __proto__: {polluted: true}}]'), /不安全/u);
  assert.throws(() => parseSubscription('x'.repeat(MAX_BYTES + 1)), /过大/u);
  assert.throws(() => parseSubscription('password: top-secret\nproxies: [\n'), error => !error.message.includes('top-secret'));
});

test('unknown YAML tags, duplicate keys and alias expansion are rejected safely', () => {
  assert.throws(() => parseSubscription('proxies: !custom []'), /解析/u);
  assert.throws(() => parseSubscription('proxies: []\nproxies: []'), /解析/u);
  assert.throws(() => parseSubscription('a: &a [one, two]\nb: &b [*a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c]\nproxies: *d'), /解析|结构|对象/u);
});

test('subscription fetch uses local HTTP and returns only the hostname', async () => {
  const server = http.createServer((request, response) => {
    assert.match(request.headers['user-agent'], /ClashMeta/u);
    response.writeHead(200, { 'Content-Type': 'text/yaml' });
    response.end('proxies:\n  - {name: Singapore, type: http, server: 127.0.0.1, port: 3128}\n');
  });
  const port = await listen(server);
  try {
    const result = await fetchSubscription(`http://127.0.0.1:${port}/subscription?token=very-secret`);
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.proxies[0].name, 'Singapore');
  } finally {
    await close(server);
  }
});

test('HTTP failures and download limits do not disclose token URLs', async () => {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/size')) {
      response.writeHead(200, { 'Content-Length': MAX_BYTES + 1 });
      response.end();
    } else {
      response.writeHead(403);
      response.end('private-token');
    }
  });
  const port = await listen(server);
  try {
    await assert.rejects(fetchSubscription(`http://127.0.0.1:${port}/bad?token=private-token`), error => /403/u.test(error.message) && !error.message.includes('private-token'));
    await assert.rejects(fetchSubscription(`http://127.0.0.1:${port}/size?token=private-token`), /过大/u);
    await assert.rejects(fetchSubscription('file:///C:/private-token'), error => !error.message.includes('private-token'));
  } finally {
    await close(server);
  }
});

test('country labels are hints and unknown names remain unknown', () => {
  assert.equal(guessCountry('🇯🇵 Tokyo 03'), 'JP');
  assert.equal(guessCountry('香港 HKT 01'), 'HK');
  assert.equal(guessCountry('US West 04'), 'US');
  assert.equal(guessCountry('Unknown node'), '');
});

test('core configuration forces selected proxy, loopback listeners and proxied DNS', () => {
  const commaName = { ...node, name: 'strange,node,#DIRECT', 'interface-name': 'eth0', 'routing-mark': 12 };
  const config = buildConfig(commaName, [commaName], 31280);
  assert.equal(config['bind-address'], '127.0.0.1');
  assert.equal(config['allow-lan'], false);
  assert.equal(config['external-controller'], '');
  assert.deepEqual(config.rules, ['MATCH,NODE_0']);
  assert.deepEqual(config['proxy-groups'], []);
  assert.equal(config.proxies[0]['interface-name'], undefined);
  assert.equal(config.proxies[0]['routing-mark'], undefined);
  assert.equal(config.dns.listen, undefined);
  assert.deepEqual(config.dns.nameserver, ['https://1.1.1.1/dns-query#NODE_0']);
  assert.deepEqual(config.dns.fallback, []);
  assert.equal(config.tun.enable, false);
  assert.equal(config['geo-auto-update'], false);
  assert.equal(config['proxy-providers'], undefined);
});

test('dialer dependencies are remapped, missing groups and cycles fail explicitly', () => {
  const first = { ...node, name: 'selected', 'dialer-proxy': 'hop' };
  const hop = { ...node, name: 'hop', port: 23457 };
  const config = buildConfig(first, [first, hop], 31280);
  assert.equal(config.proxies.length, 2);
  assert.equal(config.proxies[1]['dialer-proxy'], config.proxies[0].name);
  assert.throws(() => buildConfig(first, [first], 31280), /不存在/u);
  assert.throws(() => buildConfig(first, [first, { ...hop, 'dialer-proxy': 'selected' }], 31280), /循环/u);
  assert.throws(() => buildConfig({ ...node, certificate: 'C:/private-key' }, [{ ...node, certificate: 'C:/private-key' }], 31280), /外部文件/u);
});

const binaryPath = path.resolve(__dirname, '../vendor/mihomo.exe');
const realCore = process.platform === 'win32';

function proxyRequest(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: target, headers: { Host: new URL(target).host }, agent: false, timeout: 8000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.once('timeout', () => request.destroy(new Error('Local proxy request timeout')));
    request.once('error', reject);
  });
}

function installConnectForwarder(server, connections, label) {
  server.on('connect', (request, socket, head) => {
    connections[label]++;
    const separator = request.url.lastIndexOf(':');
    const upstream = net.connect({ host: request.url.slice(0, separator), port: Number(request.url.slice(separator + 1)) });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
}

async function proxyHttpsRequest(port, targetPort) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const onData = chunk => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      if (!response.subarray(0, end).toString('ascii').startsWith('HTTP/1.1 200')) {
        socket.destroy();
        reject(new Error('CONNECT tunnel was rejected'));
        return;
      }
      socket.pause();
      if (response.length > end + 4) socket.unshift(response.subarray(end + 4));
      resolve();
    };
    socket.once('connect', () => socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`));
    socket.on('data', onData);
    socket.once('error', reject);
    socket.setTimeout(8000, () => socket.destroy(new Error('CONNECT timeout')));
  });
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false });
    const chunks = [];
    secure.once('secureConnect', () => secure.write('GET /secure HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    secure.on('data', chunk => chunks.push(chunk));
    secure.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    secure.once('error', reject);
    secure.setTimeout(8000, () => secure.destroy(new Error('TLS tunnel timeout')));
    socket.resume();
    secure.resume();
  });
}

test('real mihomo processes isolate environment egress and remove plaintext config', { skip: !realCore, timeout: 30000 }, async () => {
  await fs.access(binaryPath);
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-proxy-test-'));
  const engine = new ProxyEngine({ binaryPath, runtimeRoot });
  const target = http.createServer((request, response) => response.end('TARGET_HTTP'));
  const upstreamA = http.createServer((request, response) => response.end(`UPSTREAM_A ${request.url}`));
  const upstreamB = http.createServer((request, response) => response.end(`UPSTREAM_B ${request.url}`));
  const secureTarget = https.createServer({ key: testKey, cert: testCert }, (request, response) => response.end('TARGET_TLS'));
  const connections = { A: 0, B: 0 };
  installConnectForwarder(upstreamA, connections, 'A');
  installConnectForwarder(upstreamB, connections, 'B');
  const targetPort = await listen(target);
  const portA = await listen(upstreamA);
  const portB = await listen(upstreamB);
  const securePort = await listen(secureTarget);
  try {
    const a = await engine.start('test/a', { ...node, name: 'A', port: portA });
    const b = await engine.start('test/b', { ...node, name: 'B', port: portB });
    assert.notEqual(a.port, b.port);
    assert.notEqual(a.pid, b.pid);
    assert.equal(engine.isRunning('test/a'), true);
    const url = `http://127.0.0.1:${targetPort}/path?q=1`;
    const resultA = await proxyRequest(a.port, url);
    const resultB = await proxyRequest(b.port, url);
    assert.equal(resultA.status, 200);
    assert.equal(resultB.status, 200);
    assert.equal(resultA.body, 'TARGET_HTTP');
    assert.equal(resultB.body, 'TARGET_HTTP');
    // The HTTP outbound adapter also tunnels ordinary HTTP over CONNECT.
    // These independent counters prove both requests used their selected node.
    assert.deepEqual(connections, { A: 1, B: 1 });
    assert.match(await proxyHttpsRequest(a.port, securePort), /TARGET_TLS/u);
    assert.deepEqual(connections, { A: 2, B: 1 });
    assert.match(await proxyHttpsRequest(b.port, securePort), /TARGET_TLS/u);
    assert.deepEqual(connections, { A: 2, B: 2 });
    const directories = await fs.readdir(runtimeRoot);
    for (const directory of directories) assert.equal((await fs.readdir(path.join(runtimeRoot, directory))).includes('config.yaml'), false);
    await close(upstreamA);
    const blocked = await proxyRequest(a.port, url);
    assert.notEqual(blocked.status, 200);
    assert.equal(blocked.body.includes('TARGET_HTTP'), false);
    assert.equal((await proxyRequest(b.port, url)).body, 'TARGET_HTTP');
    await engine.stopAll();
    assert.equal(engine.isRunning('test/a'), false);
    assert.deepEqual(await fs.readdir(runtimeRoot), []);
  } finally {
    await engine.stopAll();
    if (upstreamA.listening) await close(upstreamA);
    await close(upstreamB);
    await close(target);
    await close(secureTarget);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('unexpected core exit fires callback; invalid core config is cleaned up', { skip: !realCore, timeout: 30000 }, async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-proxy-exit-test-'));
  let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const engine = new ProxyEngine({ binaryPath, runtimeRoot, onExit: exitResolve });
  try {
    const running = await engine.start('exiting', node);
    process.kill(running.pid);
    assert.equal(await Promise.race([exited, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Exit callback timeout')), 5000))]), 'exiting');
    assert.equal(engine.isRunning('exiting'), false);
    await assert.rejects(engine.start('bad', { name: 'bad', type: 'ss', server: '127.0.0.1', port: 1234, cipher: 'INVALID-CIPHER', password: 'never-print-this' }), error => !error.message.includes('never-print-this'));
    // Unexpected exit cleanup is asynchronous after the synchronous block callback.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await fs.readdir(runtimeRoot), []);
  } finally {
    await engine.stopAll();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
