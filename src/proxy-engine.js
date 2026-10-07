'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const { validateProxies } = require('./subscription');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function probeSocks(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let complete = false;
    const finish = result => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(300);
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 2) finish(buffer[0] === 5 && buffer[1] === 0);
    });
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function prohibitFileOptions(value, parentKey = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['ca', 'ca-file', 'certificate', 'certificate-file', 'private-key-file', 'config', 'config-path', 'file', 'script'].includes(key)
      || (key === 'path' && !['ws-opts', 'http-opts', 'h2-opts', 'plugin-opts', 'grpc-opts'].includes(parentKey))) {
      throw new Error('此节点依赖外部文件或脚本，当前版本不支持。');
    }
    prohibitFileOptions(item, key);
  }
}

function buildConfig(selected, list, port) {
  const proxies = validateProxies(list);
  const byName = new Map(proxies.map(item => [item.name, item]));
  if (!selected || typeof selected.name !== 'string' || !byName.has(selected.name)) throw new Error('所选节点不在订阅列表中。');
  const visited = new Set();
  const active = new Set();
  const required = [];
  function visit(name) {
    if (active.has(name)) throw new Error('节点的 dialer-proxy 存在循环引用。');
    if (visited.has(name)) return;
    const node = byName.get(name);
    if (!node) throw new Error('节点的 dialer-proxy 引用了不存在的节点或代理组，当前版本只支持节点引用。');
    prohibitFileOptions(node);
    active.add(name);
    if (node['dialer-proxy']) visit(node['dialer-proxy']);
    active.delete(name);
    visited.add(name);
    required.push(node);
  }
  visit(selected.name);
  // Internal names cannot inject commas into a rule or collide with built-ins.
  const internalNames = new Map(required.map((item, index) => [item.name, `NODE_${index}`]));
  const outbound = internalNames.get(selected.name);
  const requiredProxies = required.map(node => {
    const clean = { ...node, name: internalNames.get(node.name) };
    if (clean['dialer-proxy']) clean['dialer-proxy'] = internalNames.get(clean['dialer-proxy']);
    // Interface selection belongs to the application, never to a subscription.
    delete clean['interface-name'];
    delete clean['routing-mark'];
    return clean;
  });
  return {
    'mixed-port': port,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'silent',
    ipv6: false,
    'find-process-mode': 'off',
    'geodata-mode': false,
    'geodata-loader': 'memconservative',
    'geosite-matcher': 'succinct',
    'geo-auto-update': false,
    'external-controller': '',
    'external-controller-unix': '',
    'external-controller-pipe': '',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    tun: { enable: false },
    sniffer: { enable: false },
    dns: {
      enable: true,
      'enhanced-mode': 'redir-host',
      ipv6: false,
      'use-hosts': false,
      'use-system-hosts': false,
      // Only node-hostname bootstrap uses the local resolver. Website queries
      // use encrypted DNS through the selected outbound, with no direct fallback.
      'proxy-server-nameserver': ['system'],
      'default-nameserver': ['system'],
      nameserver: [`https://1.1.1.1/dns-query#${outbound}`],
      fallback: [],
    },
    proxies: requiredProxies,
    'proxy-groups': [],
    rules: [`MATCH,${outbound}`],
  };
}

class ProxyEngine {
  constructor({ binaryPath, runtimeRoot, onExit = () => {} }) {
    this.binaryPath = path.resolve(binaryPath);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.onExit = onExit;
    this.processes = new Map();
  }

  get available() {
    try { return fs.statSync(this.binaryPath).isFile(); } catch { return false; }
  }

  isRunning(profileId) {
    const entry = this.processes.get(profileId);
    return Boolean(entry?.ready && !entry.exited && entry.child?.pid);
  }

  async removeRuntime(directory) {
    if (!directory) return;
    const relative = path.relative(this.runtimeRoot, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('运行目录不在允许的路径内。');
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  async start(profileId, rawProxy, allProxies = [rawProxy]) {
    if (typeof profileId !== 'string' || !profileId || profileId.length > 256) throw new Error('浏览器环境标识无效。');
    if (!this.available) throw new Error('未找到 mihomo 代理核心，请先安装应用所附代理核心。');
    if (this.processes.has(profileId)) throw new Error('此浏览器环境的代理已运行或正在启动。');
    const entry = { directory: null, child: null, ready: false, exited: false, stopping: false, exitPromise: null };
    this.processes.set(profileId, entry);
    try {
      const port = await freePort();
      const config = buildConfig(rawProxy, allProxies, port);
      await fsp.mkdir(this.runtimeRoot, { recursive: true });
      const prefix = crypto.createHash('sha256').update(profileId).digest('hex').slice(0, 16);
      entry.directory = await fsp.mkdtemp(path.join(this.runtimeRoot, `${prefix}-`));
      const configPath = path.join(entry.directory, 'config.yaml');
      await fsp.writeFile(configPath, YAML.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (entry.stopping) throw new Error('代理启动已取消。');
      const child = spawn(this.binaryPath, ['-d', entry.directory, '-f', configPath], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      entry.child = child;
      entry.exitPromise = new Promise(resolve => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          const unexpected = entry.ready && !entry.stopping;
          entry.exited = true;
          entry.ready = false;
          if (this.processes.get(profileId) === entry) this.processes.delete(profileId);
          // Notify synchronously so the browser can close before cleanup awaits.
          if (unexpected) {
            try { this.onExit(profileId); } catch { /* The caller owns callback diagnostics. */ }
          }
          this.removeRuntime(entry.directory).catch(() => {});
          resolve();
        };
        child.once('error', finish);
        child.once('exit', finish);
      });
      const deadline = Date.now() + 12000;
      while (!entry.exited && !entry.stopping && Date.now() < deadline) {
        if (await probeSocks(port)) {
          // Confirm our process is alive after a bind failure could have raced a
          // port owned by another process. Readiness says listening, not node reachability.
          await sleep(100);
          if (entry.exited || entry.stopping) break;
          await fsp.unlink(configPath);
          if (entry.exited || entry.stopping) throw new Error('代理核心在启动时退出。');
          entry.ready = true;
          return { port, pid: child.pid };
        }
        await sleep(80);
      }
      throw new Error('代理核心无法启动，请检查节点协议与配置。');
    } catch (error) {
      entry.stopping = true;
      if (entry.child && !entry.exited) {
        entry.child.kill();
        await Promise.race([entry.exitPromise, sleep(3000)]);
      }
      await this.removeRuntime(entry.directory).catch(() => {});
      if (this.processes.get(profileId) === entry) this.processes.delete(profileId);
      if (error instanceof Error && /^(节点|所选|此节点|运行目录|代理)/u.test(error.message)) throw error;
      throw new Error('代理启动失败，请检查代理核心和运行目录权限。');
    }
  }

  async stop(profileId) {
    const entry = this.processes.get(profileId);
    if (!entry) return;
    entry.stopping = true;
    entry.ready = false;
    if (entry.child && !entry.exited) {
      entry.child.kill();
      await Promise.race([entry.exitPromise, sleep(3000)]);
      if (!entry.exited) {
        entry.child.kill('SIGKILL');
        await Promise.race([entry.exitPromise, sleep(2000)]);
      }
    }
    await this.removeRuntime(entry.directory);
    if (this.processes.get(profileId) === entry) this.processes.delete(profileId);
  }

  async stopAll() {
    await Promise.all([...this.processes.keys()].map(profileId => this.stop(profileId)));
  }
}

module.exports = { ProxyEngine, buildConfig };
