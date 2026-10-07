'use strict';

const { BrowserWindow, WebContentsView, session, dialog, Menu, clipboard } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { regions, normalizeUrl, HOME_URL } = require('./regions');
const { installHomeProtocol, profileHomeUrl, isHomeNavigation } = require('./home-protocol');
const { searchUrl } = require('./fingerprint-policy');

const TOP = 136;

class BrowserHost {
  constructor({ profile, route, onClose, showManager }) {
    this.profile = profile;
    this.route = route;
    this.onClose = onClose;
    this.showManager = showManager;
    this.tabs = [];
    this.closedTabs = [];
    this.error = '';
    this.closing = false;
    this.ses = session.fromPartition(`persist:environment-${profile.id}`);
    this.window = new BrowserWindow({
      width: profile.width, height: profile.height, minWidth: 800, minHeight: 600,
      title: `${profile.name} · 游隼浏览器`, backgroundColor: '#f3f7fa', show: false, icon: path.join(__dirname, '../ui/assets/peregrine-icon.png'),
      webPreferences: { preload: path.join(__dirname, 'browser-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    });
    this.window.on('resize', () => this.layout());
    this.window.on('closed', () => {
      this.closing = true;
      for (const tab of this.tabs) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      this.tabs = [];
      this.onClose();
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.webContents.on('did-finish-load', () => this.publish());
    this.window.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    this.window.webContents.on('context-menu', (_event, params) => { if (params.isEditable) Menu.buildFromTemplate([{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }]).popup({ window: this.window }); });
    this.installPermissions();
  }

  installPermissions() {
    this.ses.setPermissionCheckHandler((_contents, permission) => permission === 'geolocation' && this.profile.locationMode === 'allow');
    this.ses.setPermissionRequestHandler(async (contents, permission, callback) => {
      if (permission !== 'geolocation' || this.profile.locationMode === 'block') return callback(false);
      if (this.profile.locationMode === 'allow') return callback(true);
      let origin;
      try { origin = new URL(contents.getURL()).origin; } catch { return callback(false); }
      const { response } = await dialog.showMessageBox(this.window, {
        type: 'question', title: '网站请求定位',
        message: `${origin} 请求使用此环境的位置。`,
        detail: `允许后将返回你设置的坐标：${this.profile.latitude}, ${this.profile.longitude}`,
        buttons: ['拒绝', '本次允许'], defaultId: 0, cancelId: 0, noLink: true
      });
      callback(response === 1);
    });
  }

  async initialize(port, initialUrl) {
    const trace = stage => { if (process.argv.includes('--self-test')) console.log(`BROWSER ${this.profile.name}: ${stage}`); };
    const language = `${this.profile.locale},${this.profile.locale.split('-')[0]}`;
    this.ses.setUserAgent(this.profile.userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`, language);
    await installHomeProtocol(this.ses);
    await this.ses.setProxy(port ? {
      mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>'
    } : { mode: 'direct' });
    await this.ses.closeAllConnections();
    trace('proxy ready, loading toolbar');
    await this.window.loadFile(path.join(__dirname, '../ui/browser.html'));
    trace('toolbar loaded, creating first tab');
    await this.createTab(initialUrl || this.profile.homepage);
    if (!this.closing) this.window.show();
  }

  async createTab(url = HOME_URL) {
    const trace = stage => { if (process.argv.includes('--self-test')) console.log(`TAB ${this.profile.name}: ${stage}`); };
    if (this.closing) return;
    const view = new WebContentsView({
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false, webSecurity: true }
    });
    const tab = { id: randomUUID(), view, title: '新标签页', ready: false };
    this.tabs.push(tab);
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(details => {
      try { const target = normalizeUrl(details.url); this.createTab(target).catch(() => this.setError('新标签页无法打开。')); } catch {}
      return { action: 'deny' };
    });
    for (const eventName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      contents.on(eventName, (event, target) => {
        const nextUrl = typeof target === 'string' ? target : event.url;
        try { if (!isHomeNavigation(nextUrl)) normalizeUrl(nextUrl); } catch { event.preventDefault(); this.setError('已阻止不受支持的网页协议。'); }
      });
    }
    contents.on('page-title-updated', (_event, title) => { tab.title = title; this.publish(); });
    for (const eventName of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) contents.on(eventName, () => this.publish());
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.setError(`网页加载失败（${code}）。请检查节点和网址，浏览器不会自动切换为直连。`);
    });
    contents.on('render-process-gone', () => this.setError('网页进程已退出，请刷新或重新启动环境。'));
    contents.on('context-menu', (_event, params) => this.contextMenu(contents, params));
    contents.on('before-input-event', (event, input) => {
      if (this.handleShortcut(event, input)) return;
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (input.control && key === 'l') { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.executeJavaScript("document.getElementById('address').focus(); document.getElementById('address').select()"); }
      if (input.control && key === 't') { event.preventDefault(); this.createTab().catch(() => this.setError('标签页初始化失败。')); }
      if (input.control && key === 'w') { event.preventDefault(); this.closeTab(tab.id); }
      if ((input.control && key === 'r') || key === 'f5') { event.preventDefault(); contents.reload(); }
      if (input.alt && key === 'arrowleft' && contents.navigationHistory.canGoBack()) { event.preventDefault(); contents.navigationHistory.goBack(); }
      if (input.alt && key === 'arrowright' && contents.navigationHistory.canGoForward()) { event.preventDefault(); contents.navigationHistory.goForward(); }
    });
    this.selectTab(tab.id);
    try {
      await contents.loadURL('about:blank');
      trace('blank page loaded');
      contents.debugger.attach('1.3');
      await contents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: this.profile.timezone });
      trace('timezone configured');
      await contents.debugger.sendCommand('Emulation.setLocaleOverride', { locale: this.profile.locale.replaceAll('-', '_') });
      trace('locale configured');
      await contents.debugger.sendCommand('Emulation.setGeolocationOverride', { latitude: this.profile.latitude, longitude: this.profile.longitude, accuracy: 30 });
      trace('geolocation configured');
      await contents.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: this.ses.getUserAgent(), acceptLanguage: `${this.profile.locale},${this.profile.locale.split('-')[0]}`,
        ...(!this.profile.userAgent ? { userAgentMetadata: { brands: [{ brand: 'Chromium', version: process.versions.chrome.split('.')[0] }, { brand: 'Not_A Brand', version: '24' }], fullVersionList: [{ brand: 'Chromium', version: process.versions.chrome }, { brand: 'Not_A Brand', version: '24.0.0.0' }], fullVersion: process.versions.chrome, platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false } } : {})
      });
      trace('UA configured');
      contents.debugger.on('detach', () => {
        if (!this.closing && !contents.isDestroyed()) {
          this.setError('地区配置已断开，请关闭并重新启动环境。');
          this.window.close();
        }
      });
      tab.ready = true;
      if (!this.closing && url !== 'about:blank') await this.navigate(url, tab);
      trace('first navigation complete');
      this.publish();
      return tab;
    } catch (error) {
      this.closeTab(tab.id);
      throw new Error('浏览器地区设置初始化失败，请重新启动环境。');
    }
  }

  get active() { return this.tabs.find(t => t.id === this.activeId); }

  get isAlive() { return !this.window.isDestroyed(); }
  show() { if (this.isAlive) { if (this.window.isMinimized()) this.window.restore(); this.window.show(); this.window.focus(); } }
  focus() { this.show(); }
  async close() { if (this.isAlive) this.window.destroy(); }

  handleShortcut(event, input) {
    if (input.type !== 'keyDown') return false;
    const key = input.key.toLowerCase(), contents = this.active?.view.webContents;
    let action;
    if (input.control && key === 'l' || key === 'f6' || input.alt && key === 'd') action = () => { this.window.webContents.focus(); this.window.webContents.executeJavaScript("document.getElementById('address').focus(); document.getElementById('address').select()"); };
    else if (input.control && input.shift && key === 't') action = () => { const url = this.closedTabs.pop(); if (url) this.createTab(url).catch(() => this.setError('无法恢复标签页。')); };
    else if (input.control && key === 't') action = () => this.createTab().catch(() => this.setError('标签页初始化失败。'));
    else if (input.control && (key === 'w' || key === 'f4')) action = () => this.closeTab(this.activeId);
    else if ((input.control && key === 'r') || key === 'f5') action = () => input.shift || input.control && key === 'f5' ? contents?.reloadIgnoringCache() : contents?.reload();
    else if (input.control && (key === 'tab' || key === 'pageup' || key === 'pagedown')) action = () => { const index = this.tabs.findIndex(t => t.id === this.activeId); const delta = input.shift || key === 'pageup' ? -1 : 1; this.selectTab(this.tabs[(index + delta + this.tabs.length) % this.tabs.length]?.id); };
    else if (input.control && /^[1-9]$/.test(key)) action = () => this.selectTab(this.tabs[key === '9' ? this.tabs.length - 1 : Number(key) - 1]?.id);
    else if (input.alt && key === 'arrowleft') action = () => { if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); };
    else if (input.alt && key === 'arrowright') action = () => { if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); };
    else if (input.alt && key === 'home') action = () => this.navigate(this.profile.homepage);
    else if (key === 'escape') action = () => { contents?.stop(); contents?.stopFindInPage('keepSelection'); this.window.webContents.executeJavaScript("document.getElementById('find-bar').hidden=true"); };
    else if (input.control && key === 'f') action = () => { this.window.webContents.focus(); this.window.webContents.executeJavaScript("document.getElementById('find-bar').hidden=false;document.getElementById('find-text').focus();document.getElementById('find-text').select()"); };
    else if (input.control && key === 'p') action = () => contents?.print({ printBackground: true });
    else if (input.control && key === 's') action = () => this.savePage();
    else if (input.control && ['+', '=', '-', '0'].includes(key)) action = () => contents?.setZoomLevel(key === '0' ? 0 : Math.max(-5, Math.min(5, contents.getZoomLevel() + (key === '-' ? -1 : 1))));
    if (!action) return false;
    event.preventDefault(); action(); return true;
  }

  async savePage() {
    const contents = this.active?.view.webContents;
    if (!contents) return;
    const { canceled, filePath } = await dialog.showSaveDialog(this.window, { title: '保存网页', defaultPath: '网页.html', filters: [{ name: 'HTML 网页', extensions: ['html'] }] });
    if (!canceled && filePath) await contents.savePage(filePath, 'HTMLComplete').catch(() => this.setError('网页保存失败。'));
  }

  contextMenu(contents, params) {
    const items = [];
    if (params.linkURL) {
      try { const url = normalizeUrl(params.linkURL); items.push({ label: '在新标签页打开链接', click: () => this.createTab(url).catch(() => this.setError('链接无法打开。')) }); } catch {}
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) });
    }
    if (params.mediaType === 'image' && /^https?:/i.test(params.srcURL)) items.push({ label: '图片另存为…', click: () => contents.downloadURL(params.srcURL) }, { label: '复制图片地址', click: () => clipboard.writeText(params.srcURL) });
    if (params.isEditable) items.push({ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' });
    else if (params.selectionText) items.push({ role: 'copy', label: '复制' }, { label: '搜索所选文字', click: () => this.createTab(searchUrl(params.selectionText,this.profile.searchEngine)).catch(() => {}) });
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: '后退', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() }, { label: '前进', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() }, { label: '重新加载', click: () => contents.reload() }, { type: 'separator' }, { label: '新建标签页', accelerator: 'Ctrl+T', click: () => this.createTab().catch(() => {}) }, { label: '保存网页…', accelerator: 'Ctrl+S', click: () => this.savePage() }, { label: '打印…', accelerator: 'Ctrl+P', click: () => contents.print({ printBackground: true }) });
    Menu.buildFromTemplate(items).popup({ window: this.window });
  }

  selectTab(id) {
    const next = this.tabs.find(t => t.id === id);
    if (!next || this.closing) return;
    for (const tab of this.tabs) {
      if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view);
    }
    this.activeId = id;
    this.window.contentView.addChildView(next.view);
    next.view.setVisible(true);
    this.layout();
    next.view.webContents.focus();
    this.publish();
  }

  layout() {
    if (this.closing || !this.active) return;
    const [width, height] = this.window.getContentSize();
    this.active.view.setBounds({ x: 0, y: TOP, width, height: Math.max(0, height - TOP) });
  }

  closeTab(id) {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;
    this.closedTabs.push(tab.view.webContents.getURL());
    if (this.closedTabs.length > 20) this.closedTabs.shift();
    if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view);
    this.tabs = this.tabs.filter(t => t.id !== id);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.debugger.removeAllListeners('detach');
      tab.view.webContents.close();
    }
    if (!this.tabs.length) { this.window.close(); return; }
    if (this.activeId === id) this.selectTab(this.tabs.at(-1).id);
    this.publish();
  }

  async navigate(value, tab = this.active) {
    if (!tab) return;
    if (!tab.ready) throw new Error('标签页正在准备，请稍候。');
    let url;
    const input = String(value || '').trim();
    if (!input || isHomeNavigation(input)) url = profileHomeUrl(this.profile);
    else if (/\s/.test(input) || (!input.includes('.') && !input.includes(':') && input !== 'localhost'))
      url = searchUrl(input,this.profile.searchEngine);
    else url = normalizeUrl(input);
    this.error = '';
    await tab.view.webContents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED') this.setError('无法加载此网页，请检查网络或节点。'); });
    this.publish();
  }

  setError(error) { this.error = error; this.publish(); }

  getState() {
    const region = regions.find(r => r.id === this.profile.regionId);
    return {
      name: this.profile.name, region: `${region.country} · ${region.city}`, route: this.route,
      locale: this.profile.locale, timezone: this.profile.timezone, locationMode: this.profile.locationMode,
      error: this.error, activeId: this.activeId,
      tabs: this.tabs.filter(t => !t.view.webContents.isDestroyed()).map(t => ({
        id: t.id, title: t.title, url: t.view.webContents.getURL(), loading: t.view.webContents.isLoading(),
        canGoBack: t.view.webContents.navigationHistory.canGoBack(), canGoForward: t.view.webContents.navigationHistory.canGoForward()
      }))
    };
  }

  publish() {
    if (this.closing || this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send('browser:state', this.getState());
    this.window.setTitle(`${this.active?.title || this.profile.name} · ${this.profile.name} · 游隼浏览器`);
  }

  async command(action, value) {
    const contents = this.active?.view.webContents;
    switch (action) {
      case 'getState': return this.publish();
      case 'navigate': return this.navigate(value);
      case 'newTab': return this.createTab();
      case 'selectTab': return this.selectTab(String(value));
      case 'closeTab': return this.closeTab(String(value));
      case 'back': if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case 'forward': if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case 'reload': contents?.reload(); break;
      case 'stop': contents?.stop(); break;
      case 'home': return this.navigate(this.profile.homepage);
      case 'find': if (value) contents?.findInPage(String(value)); else contents?.stopFindInPage('clearSelection'); break;
      case 'manager': return this.showManager();
      default: throw new Error('浏览器操作无效。');
    }
    this.publish();
  }
}

module.exports = { BrowserHost };
