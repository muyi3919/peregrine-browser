'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CdpPipe } = require('./cdp-pipe');
const { CORE_VERSION, SEARCH_ENGINES, userAgentOverride, buildDevicePolicySource } = require('./fingerprint-policy');
const { buildFingerprintPixelsSource } = require('./fingerprint-pixels');
const { rewriteDeviceMemoryRequestHeaders } = require('./fingerprint-headers');
const { startNativeWindowBranding } = require('./native-brand-window');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));

function launchArguments(profile, proxyPort, directory, extension) {
  if(!Number.isInteger(profile.fingerprintSeed) || profile.fingerprintSeed < 0 || profile.fingerprintSeed > 0xffffffff) throw new Error('原生指纹种子必须是 uint32 整数。');
  if(proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw new Error('独立代理端口无效。');
  const language=profile.locale || 'en-US';
  return [
    `--fingerprint=${profile.fingerprintSeed}`, '--fingerprint-brand=Chrome',
    `--fingerprint-brand-version=${userAgentOverride(profile).userAgentMetadata?.fullVersion || CORE_VERSION}`,
    `--user-agent=${userAgentOverride(profile).userAgent}`,
    `--fingerprint-hardware-concurrency=${profile.hardwareConcurrency || 8}`,
    ...(profile.canvasMode === 'native' ? [] : ['--disable-spoofing=canvas']),
    `--lang=${language}`, `--accept-lang=${language},${language.split('-')[0]}`,
    `--timezone=${profile.timezone || 'UTC'}`,
    ...(proxyPort === undefined ? ['--no-proxy-server'] : [`--proxy-server=http://127.0.0.1:${proxyPort}`,'--proxy-bypass-list=<-loopback>']), '--disable-non-proxied-udp',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--user-data-dir=${directory}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-sync', '--disable-features=MediaRouter,OptimizationHints,Translate',
    `--window-size=${profile.width || 1280},${profile.height || 900}`,
    ...(extension ? [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] : []),
    'about:blank',
  ];
}

class NativeHost {
  constructor({profile,proxyPort,binaryPath,dataRoot,homepagePath,windowBranding,onDiagnostic=()=>{},onClose=()=>{}}) {
    this.profile=profile; this.proxyPort=proxyPort; this.binaryPath=path.resolve(binaryPath); this.dataRoot=path.resolve(dataRoot);
    this.homepagePath=homepagePath ? path.resolve(homepagePath) : null; this.onClose=onClose;
    this.windowBranding=windowBranding;this.brandController=null;this.brandStartPromise=null;this.onDiagnostic=onDiagnostic;
    this.directory=path.join(this.dataRoot,'native-profiles',createHash('sha256').update(profile.id).digest('hex').slice(0,32));
    this.targets=new Map(); this.setupTasks=new Map(); this.transientTargets=new Set(); this.child=null; this.cdp=null; this.exited=true; this.closing=false; this.notified=false;
    this.bootstrap=buildDevicePolicySource(profile) + (profile.canvasMode === 'stable' ? '\n' + buildFingerprintPixelsSource(profile.fingerprintSeed,{stableReadback:true}) : '');
  }
  get isAlive() { return Boolean(this.child && !this.exited); }
  diagnostic(event,error,detail={}) {try {this.onDiagnostic({event,profileId:this.profile.id,code:error?.protocolError?.code || error?.code,message:error?.protocolError?.message || error?.message,...detail});} catch {}}
  notifyClose() { if(this.notified) return; this.notified=true; try {this.onClose(this.profile.id);} catch {} }
  async preferences() {
    const file=path.join(this.directory,'Default','Preferences');
    await fs.mkdir(path.dirname(file),{recursive:true});
    let preferences={}; try { preferences=JSON.parse(await fs.readFile(file,'utf8')); } catch(error) { if(error.code !== 'ENOENT') throw new Error('独立浏览器首选项无法读取。'); }
    preferences.profile ||= {}; preferences.profile.default_content_setting_values ||= {};
    const settings=preferences.profile.default_content_setting_values;
    const security=this.profile.security || {};
    settings.media_stream_camera=security.camera === 'block' ? 2 : 3;
    settings.media_stream_mic=security.microphone === 'block' ? 2 : 3;
    settings.notifications=security.notifications === 'ask' ? 3 : 2;
    settings.geolocation=this.profile.locationMode === 'allow' ? 1 : this.profile.locationMode === 'block' ? 2 : 3;
    preferences.profile.block_third_party_cookies=security.blockThirdPartyCookies !== false;
    preferences.profile.cookie_controls_mode=security.blockThirdPartyCookies !== false ? 1 : 0;
    preferences.webrtc ||= {}; preferences.webrtc.ip_handling_policy='disable_non_proxied_udp';
    await fs.writeFile(file,JSON.stringify(preferences),{mode:0o600});
  }
  async extension() {
    const directory=path.join(this.dataRoot,'extensions',`home-${createHash('sha256').update(this.profile.id).digest('hex').slice(0,32)}`);
    await fs.mkdir(directory,{recursive:true});
    const manifest={manifest_version:3,name:'游隼环境首页与指纹策略',version:'1.1.0'};
    await fs.writeFile(path.join(directory,'fingerprint.js'),this.bootstrap);
    manifest.content_scripts=[{matches:['http://*/*','https://*/*'],js:['fingerprint.js'],run_at:'document_start',all_frames:true,match_about_blank:true,match_origin_as_fallback:true,world:'MAIN'}];
    if(this.homepagePath) {
      const source=path.dirname(this.homepagePath);
      for(const name of ['home.html','home.css','home.js']) {
        const candidate=path.join(source,name);
        try {await fs.copyFile(candidate,path.join(directory,name));} catch(error) {if(error.code !== 'ENOENT' || name === 'home.html') throw error;}
      }
      const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const environment={name:this.profile.name,profileName:this.profile.name,profileId:this.profile.id,regionId:this.profile.regionId,timezone:this.profile.timezone,locale:this.profile.locale,engine:'fingerprint',fingerprintSeed:this.profile.fingerprintSeed,hardwareConcurrency:this.profile.hardwareConcurrency};
      const homeFile=path.join(directory,'home.html');
      const html=await fs.readFile(homeFile,'utf8');
      await fs.writeFile(homeFile,html.replace(/<head([^>]*)>/iu,`<head$1><meta charset="utf-8"><meta name="peregrine-environment" content="${escape(JSON.stringify(environment))}">`));
      const sourceAssets=path.join(source,'assets');
      try {
        await fs.mkdir(path.join(directory,'assets'),{recursive:true});
        for(const entry of await fs.readdir(sourceAssets,{withFileTypes:true})) {
          if(entry.isFile() && /\.(png|jpe?g|webp|svg|ico|woff2)$/iu.test(entry.name)) await fs.copyFile(path.join(sourceAssets,entry.name),path.join(directory,'assets',entry.name));
        }
      } catch(error) {if(error.code !== 'ENOENT') throw error;}
      manifest.chrome_url_overrides={newtab:'home.html'};
    }
    if(this.profile.security?.webrtc === 'block') {
      await fs.writeFile(path.join(directory,'block-rtc.js'),"'use strict'; for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) { try { Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false}); } catch {} }\n");
      manifest.content_scripts.push({matches:['http://*/*','https://*/*'],js:['block-rtc.js'],run_at:'document_start',all_frames:true,match_about_blank:true,match_origin_as_fallback:true,world:'MAIN'});
    }
    if(this.profile.security?.httpsOnly) {
      manifest.permissions=['declarativeNetRequest'];
      manifest.declarative_net_request={rule_resources:[{id:'https_security',enabled:true,path:'https-rules.json'}]};
      await fs.writeFile(path.join(directory,'https-rules.json'),JSON.stringify([
        {id:1,priority:1,action:{type:'block'},condition:{urlFilter:'|ws://',resourceTypes:['websocket']}},
        {id:2,priority:1,action:{type:'block'},condition:{urlFilter:'|http://'}},
        {id:3,priority:1,action:{type:'block'},condition:{urlFilter:'|http://',resourceTypes:['main_frame']}},
      ]));
    }
    await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
    return directory;
  }
  async initialize() {
    if(this.closing) throw new Error('原生浏览器启动已取消。');
    if(this.child) throw new Error('此原生浏览器环境已启动。');
    await fs.access(this.binaryPath); await this.preferences();
    const extension=await this.extension();
    if(this.closing) throw new Error('原生浏览器启动已取消。');
    this.child=spawn(this.binaryPath,launchArguments(this.profile,this.proxyPort,this.directory,extension),{windowsHide:false,stdio:['ignore','ignore','ignore','pipe','pipe'],shell:false});
    this.exited=false;
    this.exitPromise=new Promise(resolve=>{
      const exited=(code,signal)=>{if(this.exited)return;this.diagnostic('native-process-exit',null,{code:typeof code==='number'?code:undefined,signal,requested:this.closing});this.exited=true;this.cdp?.close();this.brandStartPromise?.then(controller=>controller?.close()).catch(()=>{});this.notifyClose();resolve();};
      this.child.once('exit',exited);this.child.once('error',exited);
    });
    this.cdp=new CdpPipe(this.child.stdio[3],this.child.stdio[4]);
    this.cdp.once('close',()=>{if(!this.closing){this.diagnostic('native-control-disconnected');this.close().catch(error=>{this.lastError=error;});}});
    this.cdp.on('event',event=>this.handleEvent(event));
    try {
      await this.cdp.send('Browser.getVersion');
      for(const [name,value] of [['camera',this.profile.security?.camera],['microphone',this.profile.security?.microphone],['notifications',this.profile.security?.notifications || 'block'],['geolocation',this.profile.locationMode || 'ask']]) {
        await this.cdp.send('Browser.setPermission',{permission:{name},setting:value==='block'?'denied':value==='allow'?'granted':'prompt'});
      }
      await this.cdp.send('Target.setDiscoverTargets',{discover:true});
      // A service/shared worker must have only one paused owner. Attaching it
      // from both the browser and page sessions prevents Network.enable finishing.
      await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'tab',exclude:true},{type:'worker',exclude:true},{type:'iframe',exclude:true},{}]});
      const {targetInfos}=await this.cdp.send('Target.getTargets');
      for(const target of targetInfos.filter(item=>item.type==='page')) await this.attach(target.targetId);
      await this.configureSearch();
      const initial=this.profile.homepage === 'peregrine://home/' ? (this.homepagePath ? 'chrome://newtab/' : 'about:blank') : this.profile.homepage || (this.homepagePath ? 'chrome://newtab/' : 'about:blank');
      await this.navigate(initial,targetInfos.find(item=>item.type==='page')?.targetId);
      if(this.windowBranding) {
        this.brandStartPromise=startNativeWindowBranding({...this.windowBranding,pid:this.child.pid,processPath:this.binaryPath}).catch(error=>{
          this.brandWarning=error;this.diagnostic('window-branding-start-failed',error);return null;
        });
        this.brandController=await this.brandStartPromise;
        this.brandController?.exitPromise.then(result=>{
          if(!this.closing && this.isAlive) {this.brandWarning=new Error('任务栏品牌助手已退出，浏览器继续运行。');this.diagnostic('window-branding-exit',this.brandWarning,{code:result.code,signal:result.signal});}
        });
      }
      if(this.closing || !this.isAlive) throw new Error('原生浏览器启动已取消。');
      return this;
    } catch(error) {this.diagnostic('native-start-failed',error);await this.close();throw error;}
  }
  handleEvent(event) {
    if(event.method==='Target.attachedToTarget') {
      const {sessionId,targetInfo}=event.params;
      if(targetInfo.type==='page' || targetInfo.type==='iframe') this.setup(targetInfo.targetId,sessionId,targetInfo.type).catch(error=>this.setupFailed(targetInfo.targetId,sessionId,error));
      else if(['worker','service_worker','shared_worker'].includes(targetInfo.type)) this.setupWorker(targetInfo.targetId,sessionId).catch(error=>this.setupFailed(targetInfo.targetId,sessionId,error));
      else this.cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId).catch(()=>{});
    } else if(event.method==='Target.detachedFromTarget') {
      this.setupTasks.delete(event.params.sessionId);
      for(const [id,session] of this.targets) if(session===event.params.sessionId) this.targets.delete(id);
    } else if(event.method==='Target.targetDestroyed') {
      const session=this.targets.get(event.params.targetId);this.targets.delete(event.params.targetId);this.setupTasks.delete(session);this.transientTargets.delete(event.params.targetId);
    } else if(event.method==='Fetch.requestPaused') this.intercept(event).catch(error=>{
      if(/Invalid InterceptionId|Invalid interception id/i.test(error.protocolError?.message || '')) return;
      const targetId=[...this.targets].find(([,session])=>session===event.sessionId)?.[0];
      if(targetId) this.setupFailed(targetId,event.sessionId,error);
    });
  }
  async setupFailed(targetId,sessionId,error) {
    if(this.closing || this.targets.get(targetId)!==sessionId) return;
    try {
      const {targetInfos}=await this.cdp.send('Target.getTargets');
      if(!targetInfos.some(target=>target.targetId===targetId) || this.targets.get(targetId)!==sessionId) return;
    } catch {if(this.closing)return;}
    this.lastError=error;this.diagnostic('native-target-setup-failed',error);await this.close().catch(closeError=>{this.lastError=closeError;});
  }
  async intercept(event) {
    const {requestId,request,resourceType,frameId}=event.params;
    const headers=rewriteDeviceMemoryRequestHeaders(request.headers,this.profile.memoryGiB || 8);
    const updatedHeaders=headers ? {headers} : {};
    if(this.profile.security?.httpsOnly && request.url.startsWith('http:')) {
      const upgraded=new URL(request.url);upgraded.protocol='https:';
      if(resourceType==='Document') {
        await this.cdp.send('Fetch.failRequest',{requestId,errorReason:'Aborted'},event.sessionId);
        await this.cdp.send('Page.navigate',{url:upgraded.href,...(frameId?{frameId}:{})},event.sessionId);
      } else await this.cdp.send('Fetch.continueRequest',{requestId,url:upgraded.href,...updatedHeaders},event.sessionId);
    } else await this.cdp.send('Fetch.continueRequest',{requestId,...updatedHeaders},event.sessionId);
  }
  async setup(targetId,sessionId,targetType='page') {
    if(this.setupTasks.has(sessionId)) return this.setupTasks.get(sessionId);
    this.targets.set(targetId,sessionId);
    const task=(async()=>{
      await this.cdp.send('Page.enable',{},sessionId);
      if(Number.isFinite(this.profile.latitude) && Number.isFinite(this.profile.longitude)) await this.cdp.send('Emulation.setGeolocationOverride',{latitude:this.profile.latitude,longitude:this.profile.longitude,accuracy:20},sessionId);
      await this.cdp.send('Emulation.setUserAgentOverride',userAgentOverride(this.profile),sessionId);
      if(targetType==='page') await this.cdp.send('Emulation.setDeviceMetricsOverride',{width:0,height:0,mobile:false,deviceScaleFactor:this.profile.pixelRatio || 1,screenWidth:this.profile.screenWidth || 1920,screenHeight:this.profile.screenHeight || 1080},sessionId);
      await this.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:this.bootstrap,runImmediately:true},sessionId);
      await this.cdp.send('Fetch.enable',{patterns:[{urlPattern:'http://*',requestStage:'Request'},{urlPattern:'https://*',requestStage:'Request'}]},sessionId);
      if(this.profile.security?.httpsOnly) {
        await this.cdp.send('Network.enable',{},sessionId);
        await this.cdp.send('Network.setBlockedURLs',{urls:['ws://*']},sessionId);
      }
      await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'tab',exclude:true},{type:'service_worker',exclude:true},{type:'shared_worker',exclude:true},{}]},sessionId);
      await this.cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId);
    })();
    this.setupTasks.set(sessionId,task);await task;return sessionId;
  }
  async setupWorker(targetId,sessionId) {
    if(this.setupTasks.has(sessionId)) return this.setupTasks.get(sessionId);
    this.targets.set(targetId,sessionId);
    const task=(async()=>{
      await this.cdp.send('Network.enable',{},sessionId);
      await this.cdp.send('Network.setUserAgentOverride',userAgentOverride(this.profile),sessionId);
      if(this.profile.security?.httpsOnly) await this.cdp.send('Network.setBlockedURLs',{urls:['http://*','ws://*']},sessionId);
      await this.cdp.send('Runtime.enable',{},sessionId);
      const installed=await this.cdp.send('Runtime.evaluate',{expression:this.bootstrap},sessionId);
      if(installed.exceptionDetails) throw new Error('Worker 指纹策略安装失败。');
      await this.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[{type:'tab',exclude:true},{type:'service_worker',exclude:true},{type:'shared_worker',exclude:true},{}]},sessionId);
      await this.cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId);
    })();
    this.setupTasks.set(sessionId,task);await task;return sessionId;
  }
  async attach(targetId) {
    let existing=this.targets.get(targetId);
    if(existing && this.setupTasks.has(existing)) {await this.setupTasks.get(existing);return existing;}
    const {targetInfo}=await this.cdp.send('Target.getTargetInfo',{targetId});
    existing=this.targets.get(targetId);
    if(existing && this.setupTasks.has(existing)) {await this.setupTasks.get(existing);return existing;}
    const {sessionId}=await this.cdp.send('Target.attachToTarget',{targetId,flatten:true});
    if(['worker','service_worker','shared_worker'].includes(targetInfo.type)) await this.setupWorker(targetId,sessionId);
    else await this.setup(targetId,sessionId,targetInfo.type);
    return this.targets.get(targetId);
  }
  async configureSearch() {
    const engineKey=this.profile.searchEngine || 'bing';
    const engine=SEARCH_ENGINES[engineKey];
    if(!engine) throw new Error('搜索引擎设置无效。');
    const markerPath=path.join(this.directory,'peregrine-settings.json');
    let previous={}; try {previous=JSON.parse(await fs.readFile(markerPath,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
    if(previous.searchEngine===engineKey) return;
    // Let Chromium update its protected search preferences through its own
    // settings controller. Writing the unprotected JSON does not persist.
    const {targetId}=await this.cdp.send('Target.createTarget',{url:'about:blank',background:true});
    this.transientTargets.add(targetId);
    try {
      const sessionId=await this.attach(targetId);
      await this.cdp.send('Page.navigate',{url:'chrome://settings/searchEngines'},sessionId);
      const expression=`(() => {
        const entries=[];
        function walk(root) { for(const e of root.querySelectorAll('*')) { if(e.tagName==='SETTINGS-SEARCH-ENGINE-ENTRY') entries.push(e); if(e.shadowRoot) walk(e.shadowRoot); } }
        walk(document);
        const entry=entries.find(e=>e.engine?.keyword===${JSON.stringify(engine.keyword)});
        if(!entry) return {ready:false,missing:entries.length>0};
        if(entry.engine.default) return {ready:true,selected:true};
        entry.onMakeDefaultClick_(); return {ready:true,selected:false};
      })()`;
      let selected=false,created=false;
      for(let attempt=0;attempt<80;attempt++) {
        const result=await this.cdp.send('Runtime.evaluate',{expression,returnByValue:true},sessionId);
        if(result.exceptionDetails) throw new Error('无法设置原生地址栏搜索引擎。');
        if(result.result?.value?.selected) {selected=true;break;}
        if(result.result?.value?.missing && !created) {
          // This shipped Ungoogled Chromium WebUI requires four fields,
          // including an empty suggestions URL, for its native edit controller.
          const url=engine.url.replace('{searchTerms}','%s');
          const add=await this.cdp.send('Runtime.evaluate',{expression:`chrome.send('searchEngineEditStarted',[0]);chrome.send('searchEngineEditCompleted',${JSON.stringify([engine.name,engine.keyword,url,''])});true`,returnByValue:true},sessionId);
          if(add.exceptionDetails) throw new Error('无法添加地址栏搜索引擎。');
          created=true;
        }
        await delay(100);
      }
      if(!selected) throw new Error('原生地址栏搜索引擎设置超时。');
      await fs.writeFile(markerPath,JSON.stringify({searchEngine:engineKey}),{mode:0o600});
    } finally {
      if(!this.closing) {
        const result=await this.cdp.send('Target.closeTarget',{targetId});
        if(!result.success && (await this.cdp.send('Target.getTargets')).targetInfos.some(t=>t.targetId===targetId)) throw new Error('搜索配置标签页未能关闭。');
      }
    }
  }
  async session(targetId) {
    if(!this.isAlive || this.closing) throw new Error('原生浏览器已关闭。');
    if(!targetId) {
      const {targetInfos}=await this.cdp.send('Target.getTargets');
      targetId=targetInfos.find(target=>target.type==='page' && !this.transientTargets.has(target.targetId) && !target.url.startsWith('chrome-extension://'))?.targetId || targetInfos.find(target=>target.type==='page' && !this.transientTargets.has(target.targetId))?.targetId;
    }
    if(!targetId) throw new Error('没有可用的浏览器标签页。');
    return this.attach(targetId);
  }
  normalizeNavigation(value,initial=false) {
    if(value==='about:blank') return value;
    const url=new URL(value);
    if(initial && this.homepagePath && url.href==='chrome://newtab/') return url.href;
    if(initial && this.homepagePath && url.href===pathToFileURL(this.homepagePath).href) return url.href;
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页地址仅支持 HTTP 和 HTTPS。');
    if(this.profile.security?.httpsOnly && url.protocol==='http:') url.protocol='https:';
    return url.href;
  }
  async navigate(url,targetId) {
    const sessionId=await this.session(targetId);
    const result=await this.cdp.send('Page.navigate',{url:this.normalizeNavigation(url,true)},sessionId);
    if(result.errorText) throw new Error('页面加载失败，请检查节点与网页连接。');
    return result;
  }
  async newTab(url='about:blank') {
    const {targetId}=await this.cdp.send('Target.createTarget',{url:'about:blank'});
    await this.attach(targetId);
    await this.navigate(url,targetId);
    return targetId;
  }
  async evaluate(expression,targetId) {
    const sessionId=await this.session(targetId);
    const result=await this.cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true},sessionId);
    if(result.exceptionDetails) throw new Error('页面表达式执行失败。');
    return result.result?.value;
  }
  async screenshot(targetId) {
    const sessionId=await this.session(targetId);
    return Buffer.from((await this.cdp.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64');
  }
  async navigationHistory(targetId) {return this.cdp.send('Page.getNavigationHistory',{},await this.session(targetId));}
  async show() {
    const sessionId=await this.session();
    await this.cdp.send('Page.bringToFront',{},sessionId);
  }
  async focus() {return this.show();}
  async close() {
    if(this.closePromise) return this.closePromise;
    this.closing=true;
    this.closePromise=(async()=>{
      if(this.child && !this.exited) {
        this.cdp?.send('Browser.close').catch(()=>{});
        await Promise.race([this.exitPromise,delay(1500)]);
        if(!this.exited) {
          if(process.platform==='win32') await run('taskkill.exe',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{});
          else this.child.kill('SIGKILL');
          await Promise.race([this.exitPromise,delay(1500)]);
        }
      }
      if(this.child && !this.exited) throw new Error('原生浏览器进程仍在退出，停止操作未完成。');
      await this.brandStartPromise?.then(controller=>controller?.close()).catch(()=>{});
      this.cdp?.close();this.notifyClose();
    })();
    try {await this.closePromise;} catch(error) {this.closePromise=null;throw error;}
  }
}
module.exports={NativeHost,launchArguments};
