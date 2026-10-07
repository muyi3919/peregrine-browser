'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { regions } = require('./regions');
const { Store } = require('./store');
const { fetchSubscription, parseSubscription } = require('./subscription');
const { ProxyEngine } = require('./proxy-engine');
const { BrowserHost } = require('./browser-host');
const { NativeHost } = require('./native-host');
const { createDiagnostics } = require('./diagnostics');

protocol.registerSchemesAsPrivileged([{ scheme: 'peregrine', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.setName('PeregrineBrowser');
if(process.platform==='win32') app.setAppUserModelId('local.peregrine.browser');
const selfTest = process.argv.includes('--self-test');
if (selfTest) app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'peregrine-browser-test-')));
if (!selfTest && !app.requestSingleInstanceLock()) app.quit();
let store, engine, manager, nativeBinaryPath, quitting = false, quitApproved = false;
let diagnostic=()=>{};
process.on('uncaughtExceptionMonitor',error=>diagnostic({event:'main-process-exception',code:error.code,message:error.message}));
const browsers = new Map();
const launching = new Set();
const updatingSubscriptions = new Set();

function state() {
  return {
    version: app.getVersion(), dataPath: store.dataPath, regions,
    profiles: store.profiles.map(p => ({ ...p, running: browsers.has(p.id) || launching.has(p.id) })),
    subscriptions: store.subscriptions.map(({ id, name, host, nodeCount, updatedAt }) => ({ id, name, host, nodeCount, updatedAt })),
    nodes: store.nodes.map(({ id, subscriptionId, name, type, countryCode }) => ({ id, subscriptionId, name, type, countryCode })),
    kernel: { available: engine.available, electron: process.versions.electron, chromium: process.versions.chrome, nativeAvailable: fs.existsSync(nativeBinaryPath), nativeChromium: '150.0.7871.186', engine: 'Blink' }
  };
}

function publish() { if (manager && !manager.isDestroyed()) manager.webContents.send('manager:state', state()); }
function showManager() { if (manager && !manager.isDestroyed()) { if (manager.isMinimized()) manager.restore(); manager.show(); manager.focus(); } }
function assertStopped(id) { if (browsers.has(id) || launching.has(id)) throw new Error('请先停止此环境，再修改或删除。'); }

async function launchProfile(id, options = {}) {
  if (quitting) throw new Error('应用正在退出。');
  if (browsers.has(id)) { await browsers.get(id).show(); return browsers.get(id); }
  if (launching.has(id)) throw new Error('此环境正在启动，请稍候。');
  const profile = store.profile(id);
  const node = profile.nodeId ? store.nodes.find(n => n.id === profile.nodeId) : undefined;
  if (profile.nodeId && !node) throw new Error('节点已从订阅移除，请在环境设置中重新选择。');
  if (node && updatingSubscriptions.has(node.subscriptionId)) throw new Error('此订阅正在更新，请稍后启动。');
  launching.add(id); publish();
  let host;
  try {
    const proxy = node ? await engine.start(id, node.raw, store.nodes.filter(n => n.subscriptionId === node.subscriptionId).map(n => n.raw)) : undefined;
    if (quitting) throw new Error('应用正在退出。');
    const hostOptions = {
      profile, route: node ? `代理：${node.name}` : '直连 · 本机出口', showManager,
      onClose: () => { browsers.delete(id); engine.stop(id).catch(() => {}); publish(); }
    };
    if (profile.engine === 'fingerprint') {
      if (!fs.existsSync(nativeBinaryPath)) throw new Error('独立指纹内核未安装，请重新安装完整版本。');
      host = new NativeHost({ ...hostOptions, onDiagnostic:diagnostic, proxyPort: proxy?.port, binaryPath: nativeBinaryPath, dataRoot: store.dataPath, homepagePath: path.join(__dirname, '../ui/home.html'), windowBranding: {
        iconPath: app.isPackaged ? path.join(process.resourcesPath,'peregrine.ico') : path.join(__dirname,'../ui/assets/peregrine.ico'),
        relaunchPath: process.execPath, relaunchArguments: app.isPackaged ? [] : [app.getAppPath()]
      } });
    } else host = new BrowserHost(hostOptions);
    browsers.set(id, host);
    await host.initialize(proxy?.port, options.initialUrl);
    if (!host.isAlive) throw new Error('浏览器已退出，请重新启动环境。');
    if (quitting) throw new Error('应用正在退出。');
    if (node && !engine.isRunning(id)) throw new Error('节点代理已退出，请重新启动环境。');
    return host;
  } catch (error) {
    if (host) await host.close();
    browsers.delete(id);
    await engine.stop(id);
    throw error;
  } finally { launching.delete(id); publish(); }
}

async function stopProfile(id) {
  if (launching.has(id)) throw new Error('环境正在启动，请等待启动完成后停止。');
  const host = browsers.get(id);
  if (host) await host.close();
  browsers.delete(id);
  await engine.stop(id);
  publish();
}

function requireManager(event) {
  if (!manager || event.sender !== manager.webContents || event.senderFrame !== manager.webContents.mainFrame)
    throw new Error('此操作仅允许在环境管理窗口中执行。');
}

function registerIPC() {
  const actions = {
    getState: async () => {},
    saveProfile: async input => { assertStopped(input?.id); store.saveProfile(input); },
    duplicateProfile: async id => { store.duplicateProfile(String(id)); },
    deleteProfile: async id => {
      assertStopped(id); store.profile(id);
      const ses = require('electron').session.fromPartition(`persist:environment-${id}`);
      await ses.clearStorageData(); await ses.clearCache();
      // The directory is derived solely from a known profile ID, below userData.
      const digest = require('node:crypto').createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
      for (const parts of [['native-profiles', digest], ['extensions', `home-${digest}`]]) {
        const target = path.resolve(store.dataPath, ...parts), root = path.resolve(store.dataPath) + path.sep;
        if (!target.startsWith(root)) throw new Error('环境数据目录无效。');
        await fs.promises.rm(target, { recursive: true, force: true });
      }
      store.saveProfiles(store.profiles.filter(p => p.id !== id));
    },
    launchProfile: async id => { await launchProfile(String(id)); },
    stopProfile: async id => { await stopProfile(String(id)); },
    importSubscription: async input => {
      if (!input || typeof input.url !== 'string') throw new Error('请输入 Clash 订阅链接。');
      const result = await fetchSubscription(input.url);
      store.importSubscription({ ...result, url: input.url, name: input.name });
    },
    refreshSubscription: async id => {
      const subscription = store.subscriptions.find(s => s.id === id);
      if (!subscription) throw new Error('订阅不存在。');
      if (!subscription.url) throw new Error('本地 YAML 请重新导入文件。');
      if (updatingSubscriptions.has(id)) throw new Error('此订阅正在更新。');
      const related = new Set(store.nodes.filter(n => n.subscriptionId === id).map(n => n.id));
      if (store.profiles.some(p => related.has(p.nodeId) && (browsers.has(p.id) || launching.has(p.id))))
        throw new Error('请先停止使用此订阅的环境，再刷新节点。');
      updatingSubscriptions.add(id);
      try { const result = await fetchSubscription(subscription.url); store.importSubscription({ ...subscription, ...result }); }
      finally { updatingSubscriptions.delete(id); }
    },
    deleteSubscription: async id => { store.deleteSubscription(String(id)); },
    importFile: async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(manager, { title: '导入 Clash YAML', properties: ['openFile'], filters: [{ name: 'Clash 配置', extensions: ['yaml', 'yml', 'txt'] }] });
      if (canceled) return null;
      if (fs.statSync(filePaths[0]).size > 10 * 1024 * 1024) throw new Error('订阅文件不能超过 10 MB。');
      const proxies = parseSubscription(fs.readFileSync(filePaths[0], 'utf8'));
      store.importSubscription({ name: path.basename(filePaths[0]), host: '本地文件', proxies });
    },
    revealData: async () => { const error = await shell.openPath(store.dataPath); if (error) throw new Error('无法打开数据目录。'); }
  };
  for (const [action, handler] of Object.entries(actions)) ipcMain.handle(`manager:${action}`, async (event, input) => {
    requireManager(event); const result = await handler(input); publish(); return result === null ? null : state();
  });
  ipcMain.handle('browser:command', async (event, input) => {
    const host = [...browsers.values()].find(h => h.window?.webContents === event.sender);
    if (!host || event.senderFrame !== host.window.webContents.mainFrame) throw new Error('浏览器控制请求无效。');
    await host.command(input?.action, input?.value);
  });
}

async function createManager() {
  manager = new BrowserWindow({
    width: 1280, height: 900, minWidth: 1080, minHeight: 720, title: '游隼浏览器 · 环境管理', backgroundColor: '#f4f7fb', show: false, icon: path.join(__dirname, '../ui/assets/peregrine-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
  });
  manager.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  manager.webContents.on('will-navigate', event => event.preventDefault());
  manager.webContents.on('did-finish-load', publish);
  manager.on('close', () => { for (const host of browsers.values()) host.close().catch(() => {}); });
  await manager.loadFile(path.join(__dirname, '../ui/index.html'));
  manager.show();
  return manager;
}

app.on('second-instance', showManager);
app.on('window-all-closed', () => { if (!selfTest) app.quit(); });
app.on('before-quit', event => {
  if (quitApproved || !engine) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  (async () => {
    const results = await Promise.allSettled([...browsers.values()].map(host => host.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('有浏览环境未能退出。应用会保留运行，请重试停止环境后再退出。');
    await engine.stopAll();
    quitApproved = true;
    app.quit();
  })().catch(async error => {
    quitting = false;
    if (!manager || manager.isDestroyed()) await createManager();
    else showManager();
    publish();
    dialog.showErrorBox('游隼浏览器暂未退出', error.message);
  });
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'), safeStorage);
  diagnostic=createDiagnostics(store.dataPath,app.getVersion());
  diagnostic({event:'application-start'});
  app.on('render-process-gone',(_event,_contents,details)=>diagnostic({event:'renderer-exit',reason:details.reason,code:details.exitCode}));
  app.on('child-process-gone',(_event,details)=>diagnostic({event:'application-child-exit',reason:details.reason,code:details.exitCode}));
  nativeBinaryPath = app.isPackaged ? path.join(process.resourcesPath, 'vendor/fingerprint-chromium/runtime/chrome.exe') : path.join(__dirname, '../vendor/peregrine-chromium/runtime/chrome.exe');
  const binaryPath = app.isPackaged ? path.join(process.resourcesPath, 'vendor/mihomo.exe') : path.join(__dirname, '../vendor/mihomo.exe');
  engine = new ProxyEngine({ binaryPath, runtimeRoot: path.join(store.dataPath, 'runtime'), onExit: id => {
    diagnostic({event:'proxy-exit',profileId:id});
    const host = browsers.get(id);
    if (host) host.close().catch(() => {});
    publish();
  } });
  registerIPC();
  if (selfTest) {
    await require('./self-test').run({ app, store, engine, launchProfile, stopProfile, createManager, state });
    return;
  }
  await createManager();
}).catch(error => {
  if (selfTest) { console.error(error.stack || error.message); app.exit(1); return; }
  dialog.showErrorBox('游隼浏览器无法启动', error.message);
  app.quit();
});
