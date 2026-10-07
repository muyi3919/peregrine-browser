'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function run({ app, store, engine, launchProfile, stopProfile, createManager, state }) {
  const output = app.isPackaged ? path.join(app.getPath('temp'), 'PeregrineBrowser-verification') : path.join(__dirname, '../verification');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  const check = (name, detail) => { results.push({ name, result: 'passed', detail }); console.log(`PASS ${name}`); };
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/headers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); return; }
    if (request.url === '/worker.js') { response.setHeader('Content-Type', 'application/javascript'); response.end("postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language})"); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta charset="utf-8"><title>环境验证页</title><style>body{font:20px Segoe UI;padding:50px;background:#eef6fa;color:#245165}pre{line-height:1.7}</style><h1>游隼浏览器 · 地区验证</h1><pre id="result"></pre><script>document.getElementById("result").textContent=JSON.stringify({language:navigator.language,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,isolated:typeof require=== "undefined"},null,2)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const homepage = `http://127.0.0.1:${server.address().port}/`;
  const ids = [];
  try {
    const a = store.saveProfile({ engine: 'electron', name: '日本 · 东京验证', regionId: 'jp-tokyo', locationMode: 'allow', userAgent: 'Peregrine-UA-Test/1.0', homepage }); ids.push(a.id);
    const b = store.saveProfile({ engine: 'electron', name: '美国 · 纽约验证', regionId: 'us-newyork', locationMode: 'allow', homepage }); ids.push(b.id);
    const hostA = await launchProfile(a.id), hostB = await launchProfile(b.id);
    const wcA = hostA.active.view.webContents, wcB = hostB.active.view.webContents;
    const inspect = "({ userAgent:navigator.userAgent, language:navigator.language, languages:navigator.languages, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, locale:Intl.DateTimeFormat().resolvedOptions().locale, require:typeof require, api:typeof window.hangjing, toolbar:typeof window.browserControls })";
    const envA = await wcA.executeJavaScript(inspect), envB = await wcB.executeJavaScript(inspect);
    assert.equal(envA.timezone, a.timezone); assert.equal(envB.timezone, b.timezone);
    assert.equal(envA.language, a.locale); assert.equal(envB.language, b.locale);
    assert.equal(envA.userAgent, a.userAgent); assert.notEqual(envB.userAgent, a.userAgent);
    assert.equal(/Electron|PeregrineBrowser/.test(envB.userAgent), false);
    assert.equal(envA.require, 'undefined'); assert.equal(envA.api, 'undefined'); assert.equal(envA.toolbar, 'undefined');
    check('parallel regions and remote sandbox', { a: envA, b: envB });
    const headersA = await wcA.executeJavaScript("fetch('/headers').then(r=>r.json())"), headersB = await wcB.executeJavaScript("fetch('/headers').then(r=>r.json())");
    assert.ok(headersA['accept-language'].startsWith('ja-JP')); assert.ok(headersB['accept-language'].startsWith('en-US'));
    assert.equal(headersA['user-agent'], a.userAgent); assert.notEqual(headersB['user-agent'], a.userAgent);
    check('custom UA is applied to browser and HTTP requests');
    check('independent HTTP language headers');
    await wcA.executeJavaScript("localStorage.setItem('isolation', 'tokyo'); document.cookie = 'isolation=tokyo; path=/'");
    assert.equal(await wcB.executeJavaScript("localStorage.getItem('isolation')"), null);
    assert.equal(await wcB.executeJavaScript("document.cookie.includes('isolation=tokyo')"), false);
    const second = await hostA.createTab(homepage);
    assert.equal(await second.view.webContents.executeJavaScript("localStorage.getItem('isolation')"), 'tokyo');
    check('cookies and storage isolated across environments, shared within tabs');
    const geolocation = "new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude}),e=>reject(new Error(e.message)),{timeout:5000}))";
    const geoA = await wcA.executeJavaScript(geolocation); assert.equal(geoA.latitude, a.latitude); assert.equal(geoA.longitude, a.longitude);
    const geoB = await wcB.executeJavaScript(geolocation); assert.equal(geoB.latitude, b.latitude); assert.equal(geoB.longitude, b.longitude);
    check('independent geolocation', { a: geoA, b: geoB });
    const worker = "new Promise((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=()=>reject(new Error('worker failed'))})";
    const workerA = await wcA.executeJavaScript(worker), workerB = await wcB.executeJavaScript(worker);
    check('worker behavior recorded', { a: workerA, b: workerB, regionalTimezoneMatched: workerA.timezone === a.timezone && workerB.timezone === b.timezone });
    await hostA.window.webContents.executeJavaScript("document.getElementById('address').value='example.com'");
    hostA.window.show(); hostA.window.focus(); hostA.active.view.webContents.focus();
    await delay(150);
    const browserImage = await hostA.window.capturePage();
    fs.writeFileSync(path.join(output, 'browser-window.png'), browserImage.toPNG());
    const contentBounds = hostA.active.view.getBounds();
    assert.ok(contentBounds.width >= 800 && contentBounds.height >= 300);
    assert.equal(hostA.active.view.getVisible(), true);
    assert.ok(hostA.window.contentView.children.includes(hostA.active.view));
    try { fs.writeFileSync(path.join(output, 'browser-page.png'), (await hostA.active.view.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); }
    catch (error) { console.log(`Native view screenshot unavailable: ${error.message}`); }
    await stopProfile(a.id);
    const reopened = await launchProfile(a.id);
    assert.equal(await reopened.active.view.webContents.executeJavaScript("localStorage.getItem('isolation')"), 'tokyo');
    check('environment storage persists after reopen');
    reopened.closeTab(reopened.activeId);
    await delay(50);
    await stopProfile(a.id); await stopProfile(b.id);
    const homeProfile = store.saveProfile({ engine: 'electron', name: '游隼起始页验证', regionId: 'tw-taipei' }); ids.push(homeProfile.id);
    const homeHost = await launchProfile(homeProfile.id);
    const homeContents = homeHost.active.view.webContents;
    await delay(200);
    assert.ok(homeContents.getURL().startsWith('peregrine://home/'));
    assert.equal(await homeContents.executeJavaScript("document.body.innerText.includes('游隼')"), true);
    assert.equal(await homeContents.executeJavaScript("typeof window.hangjing + '/' + typeof require"), 'undefined/undefined');
    assert.equal(await homeContents.executeJavaScript("fetch('https://example.com').then(()=>false,()=>true)"), true);
    homeHost.window.show(); homeHost.window.focus(); homeContents.focus(); await delay(150);
    const { Menu } = require('electron');
    const popup = Menu.prototype.popup;
    let menuShown = false, menuRequested = false, menuLabels = [];
    Menu.prototype.popup = function (options) {
      menuRequested = true; menuLabels = this.items.map(item => item.label);
      this.once('menu-will-show', () => { menuShown = true; });
      const result = popup.call(this, options);
      setTimeout(() => this.closePopup(options?.window), 150);
      return result;
    };
    try {
      homeContents.sendInputEvent({ type: 'mouseDown', x: 160, y: 80, button: 'right', clickCount: 1 });
      homeContents.sendInputEvent({ type: 'mouseUp', x: 160, y: 80, button: 'right', clickCount: 1 });
      await delay(300);
      assert.equal(menuRequested, true); assert.equal(menuShown, true);
      assert.ok(menuLabels.includes('重新加载')); assert.ok(menuLabels.includes('保存网页…'));
      check('real right click opens native context menu', { items: menuLabels });
    } finally { Menu.prototype.popup = popup; }
    try { fs.writeFileSync(path.join(output, 'home-page.png'), (await homeContents.capturePage(undefined, { stayAwake: true })).toPNG()); } catch (error) { console.log(`Home screenshot unavailable: ${error.message}`); }
    const press = async (contents, keyCode, modifiers = ['control']) => { contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(200); };
    await press(homeContents, 'L');
    assert.equal(await homeHost.window.webContents.executeJavaScript("document.activeElement.id"), 'address');
    await press(homeHost.window.webContents, 'T');
    for (let i = 0; i < 40 && !homeHost.active?.ready; i++) await delay(50);
    assert.equal(homeHost.tabs.length, 2);
    assert.ok(homeHost.active.view.webContents.getURL().startsWith('peregrine://home/'));
    await press(homeHost.active.view.webContents, 'W'); assert.equal(homeHost.tabs.length, 1);
    await press(homeHost.active.view.webContents, 'T', ['control', 'shift']);
    for (let i = 0; i < 40 && !homeHost.active?.ready; i++) await delay(50);
    assert.equal(homeHost.tabs.length, 2);
    await press(homeHost.active.view.webContents, 'F');
    assert.equal(await homeHost.window.webContents.executeJavaScript("document.getElementById('find-bar').hidden"), false);
    await press(homeHost.window.webContents, 'Escape', []);
    assert.equal(await homeHost.window.webContents.executeJavaScript("document.getElementById('find-bar').hidden"), true);
    check('branded home, sandbox, CSP and page/toolbar keyboard shortcuts');
    await stopProfile(homeProfile.id);
    // Use a local upstream proxy with the real Mihomo binary. No paid nodes or
    // user subscriptions are needed and no claim about public IP is made.
    let routed = 0;
    const upstream = http.createServer((request, response) => {
      routed++;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>代理链验证成功</title><h1>Real Mihomo proxy path</h1>');
    });
    const proxySockets = new Set();
    upstream.on('connect', (request, client, head) => {
      routed++;
      const [hostname, port] = request.url.split(':');
      const targetSocket = net.connect(Number(port), hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) targetSocket.write(head);
        client.pipe(targetSocket); targetSocket.pipe(client);
      });
      for (const socket of [client, targetSocket]) { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); }
      targetSocket.on('error', () => client.destroy()); client.on('error', () => targetSocket.destroy());
      client.on('close', () => targetSocket.destroy()); targetSocket.on('close', () => client.destroy());
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const node = { name: '本地测试代理', type: 'http', server: '127.0.0.1', port: upstream.address().port };
      store.importSubscription({ name: '仅用于自动验证', host: 'local-test', proxies: [node] });
      const p = store.saveProfile({ engine: 'electron', name: '真实代理链验证', regionId: 'jp-tokyo', nodeId: store.nodes[0].id, homepage }); ids.push(p.id);
      const host = await launchProfile(p.id);
      assert.equal(await host.active.view.webContents.executeJavaScript('document.title'), '环境验证页');
      assert.ok(routed > 0); assert.ok(engine.isRunning(p.id));
      check('browser routes through real Mihomo and selected upstream');
      const entry = engine.processes.get(p.id);
      entry.child.kill();
      for (let i = 0; i < 40 && !host.window.isDestroyed(); i++) await delay(100);
      assert.equal(host.window.isDestroyed(), true);
      check('proxy exit closes environment without direct fallback');
      const native = store.saveProfile({ name: '原生指纹代理验证', regionId: 'jp-tokyo', nodeId: store.nodes[0].id, homepage, security: { httpsOnly: false } }); ids.push(native.id);
      const nativeHost = await launchProfile(native.id);
      for (let i = 0; i < 60 && await nativeHost.evaluate('document.readyState') !== 'complete'; i++) await delay(50);
      const nativeInfo = await nativeHost.evaluate("({ua:navigator.userAgent,locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency,title:document.title})");
      assert.equal(nativeInfo.title, '环境验证页'); assert.equal(nativeInfo.locale, 'ja-JP'); assert.equal(nativeInfo.timezone, 'Asia/Tokyo'); assert.equal(nativeInfo.cores, 8); assert.equal(nativeInfo.ua.includes('Electron'), false);
      assert.equal(nativeInfo.ua.includes('Chrome/150.'), true);
      const {inspectNativeWindows,APP_USER_MODEL_ID,PRODUCT_NAME}=require('./native-brand-window');
      const nativeBrand=await inspectNativeWindows({pid:nativeHost.child.pid,processPath:nativeHost.binaryPath,iconPath:nativeHost.windowBranding.iconPath});
      assert.ok(nativeBrand.windows.length>0);
      for(const window of nativeBrand.windows) {
        assert.equal(window.appUserModelId,APP_USER_MODEL_ID);assert.equal(window.relaunchDisplayName,PRODUCT_NAME);
        assert.ok(window.title.endsWith(' - '+PRODUCT_NAME));
        assert.equal(window.smallIconHash,nativeBrand.expectedIconHashes.small);assert.equal(window.bigIconHash,nativeBrand.expectedIconHashes.big);
      }
      assert.equal(nativeHost.brandController.isAlive,true);
      check('native window title, taskbar name and icons use Peregrine branding',nativeBrand);
      assert.ok(engine.isRunning(native.id));
      fs.writeFileSync(path.join(output, 'native-page.png'), await nativeHost.screenshot());
      engine.processes.get(native.id).child.kill();
      for (let i = 0; i < 60 && nativeHost.isAlive; i++) await delay(100);
      assert.equal(nativeHost.isAlive, false);
      check('native fingerprint engine, real Mihomo routing and proxy failure closes window', nativeInfo);
    } finally { for (const socket of proxySockets) socket.destroy(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
    store.saveProfiles([]); store.saveVault([], []);
    const nativeHome = store.saveProfile({ name: '游隼 · 原生首页', regionId: 'tw-taipei' }); ids.push(nativeHome.id);
    const nativeHomeHost = await launchProfile(nativeHome.id);
    for (let i = 0; i < 60 && !(await nativeHomeHost.evaluate("document.body?.innerText.includes('游隼')")); i++) await delay(50);
    assert.equal(await nativeHomeHost.evaluate("document.body.innerText.includes('游隼')"), true);
    assert.equal(await nativeHomeHost.evaluate("document.querySelector('meta[name=peregrine-environment]').content.includes('游隼 · 原生首页')"), true);
    fs.writeFileSync(path.join(output, 'native-home.png'), await nativeHomeHost.screenshot());
    const newHomeTarget = await nativeHomeHost.newTab('chrome://newtab/');
    for (let i = 0; i < 60 && !(await nativeHomeHost.evaluate("document.body?.innerText.includes('游隼')", newHomeTarget)); i++) await delay(50);
    assert.equal(await nativeHomeHost.evaluate("document.body.innerText.includes('游隼')", newHomeTarget), true);
    check('native built-in home and new tab work from copied extension assets');
    const aboutTarget=await nativeHomeHost.newTab('about:blank');
    const aboutNavigation=await nativeHomeHost.cdp.send('Page.navigate',{url:'chrome://settings/help'},await nativeHomeHost.session(aboutTarget));
    assert.equal(aboutNavigation.errorText,undefined);
    const inspectAbout=`(()=>{
      const elements=[];
      const walk=root=>{for(const element of root.querySelectorAll('*')){elements.push(element);if(element.shadowRoot)walk(element.shadowRoot);}};
      walk(document);
      const field=selector=>{const element=elements.find(element=>element.matches(selector));return element?{text:(element.innerText||element.textContent).trim(),visible:element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0}:null;};
      return {appVersion:field('[data-peregrine-app-version]'),engine:field('[data-peregrine-engine]'),update:field('[data-peregrine-manual-update]'),copyright:field('[data-peregrine-core-copyright]'),links:elements.filter(element=>element.matches('a[href]')).map(element=>element.href)};
    })()`;
    let aboutInfo;
    for(let i=0;i<80;i++){aboutInfo=await nativeHomeHost.evaluate(inspectAbout,aboutTarget);if(aboutInfo.appVersion?.visible)break;await delay(100);}
    assert.equal(aboutInfo.appVersion.visible,true);assert.ok(aboutInfo.appVersion.text.includes(app.getVersion()));
    assert.equal(aboutInfo.engine.visible,true);assert.ok(aboutInfo.engine.text.includes('150.0.7871.186'));assert.ok(aboutInfo.engine.text.includes('Blink'));
    assert.equal(aboutInfo.update.visible,true);assert.match(aboutInfo.update.text,/手动/u);assert.match(aboutInfo.update.text,/自动更新/u);assert.doesNotMatch(aboutInfo.update.text,/最新版本/u);
    assert.equal(aboutInfo.copyright.visible,true);assert.ok(aboutInfo.copyright.text.includes('The Chromium Authors'));
    assert.ok(aboutInfo.links.some(link=>link.startsWith('chrome://credits')));
    assert.ok(aboutInfo.links.includes('https://github.com/adryfish/fingerprint-chromium'));
    fs.writeFileSync(path.join(output,'native-about.png'),await nativeHomeHost.screenshot(aboutTarget));
    check('native About separates application version, core version, manual updates and upstream licenses',aboutInfo);
    await stopProfile(nativeHome.id);
    store.saveProfiles([]);
    const manager = await createManager();
    await delay(350);
    assert.equal(await manager.webContents.executeJavaScript("typeof window.hangjing.getState"), 'function');
    assert.equal(await manager.webContents.executeJavaScript("document.body.innerText.includes('游隼')"), true);
    fs.writeFileSync(path.join(output, 'manager-empty.png'), (await manager.webContents.capturePage()).toPNG());
    check('management UI renders and preload API is available');
    await manager.webContents.executeJavaScript("document.getElementById('create-profile').click(); document.getElementById('profile-name').value='UA 表单验证'; document.getElementById('profile-user-agent').value='Peregrine-Form-UA/1.0'; document.getElementById('profile-homepage').value='about:blank';document.getElementById('profile-location-mode').value='allow';document.getElementById('profile-latitude').value='48.8566';document.getElementById('profile-longitude').value='2.3522'");
    await delay(120);
    assert.equal(await manager.webContents.executeJavaScript("document.getElementById('profile-dialog').open"), true);
    fs.writeFileSync(path.join(output, 'manager-create.png'), (await manager.webContents.capturePage()).toPNG());
    await manager.webContents.executeJavaScript("document.getElementById('profile-latitude').scrollIntoView({block:'center'});document.getElementById('profile-name').blur()");
    fs.writeFileSync(path.join(output,'manager-gps.png'),(await manager.webContents.capturePage()).toPNG());
    await manager.webContents.executeJavaScript("document.getElementById('profile-form').requestSubmit()");
    for (let i = 0; i < 40 && !store.profiles.length; i++) await delay(50);
    const formProfile = store.profiles.find(p => p.name === 'UA 表单验证');
    assert.ok(formProfile); assert.equal(formProfile.userAgent, 'Peregrine-Form-UA/1.0');
    assert.equal(formProfile.canvasMode,'stable');assert.equal(formProfile.searchEngine,'bing');
    assert.equal(formProfile.locationMode,'allow');assert.equal(formProfile.latitude,48.8566);assert.equal(formProfile.longitude,2.3522);
    assert.ok(formProfile.screenWidth>=formProfile.width);assert.equal(formProfile.memoryGiB,8);
    await manager.webContents.executeJavaScript(`window.hangjing.duplicateProfile(${JSON.stringify(formProfile.id)})`);
    assert.equal(store.profiles.length, 2);
    for (const p of [...store.profiles]) await manager.webContents.executeJavaScript(`window.hangjing.deleteProfile(${JSON.stringify(p.id)})`);
    assert.equal(store.profiles.length, 0);
    check('environment form saves UA, duplicates and deletes through trusted IPC');
    fs.writeFileSync(path.join(output, 'browser-test-results.json'), JSON.stringify({ time: new Date().toISOString(), electron: process.versions.electron, chromium: process.versions.chrome, checks: results, kernelAvailable: state().kernel.available }, null, 2));
    await engine.stopAll();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'browser-test-results.json'), JSON.stringify({ checks: results, failure: error.stack }, null, 2));
    for (const id of ids) await stopProfile(id).catch(() => {});
    await engine.stopAll().catch(() => {});
    server.closeAllConnections(); server.close();
    throw error;
  }
}

module.exports = { run };
