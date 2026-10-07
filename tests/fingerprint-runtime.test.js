'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const http=require('node:http');const {inflateSync}=require('node:zlib');
const {NativeHost}=require('../src/native-host');
const {navigatorFingerprint,webglFingerprint,pageExpression,summarize,hash}=require('../verification/fingerprint-audit.cjs');
const binaryPath=path.resolve(__dirname,'../vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64/chrome.exe');
const base={id:'audit-default',fingerprintSeed:123456789,hardwareConcurrency:4,memoryGiB:4,screenWidth:1920,screenHeight:1080,pixelRatio:1,searchEngine:'bing',canvasMode:'compatibility',locale:'ja-JP',timezone:'Asia/Tokyo',locationMode:'block',homepage:'about:blank',security:{webrtc:'proxy',httpsOnly:false,blockThirdPartyCookies:true,camera:'block',microphone:'block',notifications:'block'}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function closeHosts(hosts){for(const host of hosts){if(host.lastError)console.log('Fingerprint host diagnostic',JSON.stringify({profileId:host.profile.id,error:host.lastError.message,protocolError:host.lastError.protocolError}));await host.close();}}
const workerCommon=`${navigatorFingerprint.toString()}\n${webglFingerprint.toString()}\nconst firstNavigator={userAgent:navigator.userAgent,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};async function collect(){return {firstNavigator,navigator:await navigatorFingerprint(),webgl:webglFingerprint(true),headers:await fetch('/headers').then(r=>r.json())}}\n`;
const workerScripts={
 '/dedicated.js':workerCommon+"collect().then(data=>postMessage(data),e=>postMessage({error:String(e)}));",
 '/shared.js':workerCommon+"onconnect=e=>collect().then(data=>e.ports[0].postMessage(data),error=>e.ports[0].postMessage({error:String(error)}));",
 '/service.js':workerCommon+"self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(collect().then(data=>e.ports[0].postMessage(data),error=>e.ports[0].postMessage({error:String(error)}))));",
};
async function canvasFingerprint(worker=false){
 const result={layer:globalThis[Symbol.for('peregrine.fingerprintPixels.v1')] || null};
 const collect=async canvas=>{canvas.width=96;canvas.height=32;const x=canvas.getContext('2d');x.fillStyle='#069';x.fillRect(3,4,47,19);x.fillStyle='rgba(220,33,71,.61)';x.fillRect(17,6,55,21);x.font='12px Arial';x.fillStyle='white';x.fillText('Stable Canvas 123',4,17);const raw=Array.from(x.getImageData(0,0,96,32).data),repeat=Array.from(x.getImageData(0,0,96,32).data);const blob=canvas instanceof OffscreenCanvas?await canvas.convertToBlob({type:'image/png'}):await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));return {raw,repeat,blob:Array.from(new Uint8Array(await blob.arrayBuffer())),dataURL:canvas instanceof OffscreenCanvas?undefined:canvas.toDataURL('image/png')};};
 if(!worker)result.html=await collect(document.createElement('canvas'));result.offscreen=await collect(new OffscreenCanvas(96,32));result.webgl=webglFingerprint(worker);return result;
}
const canvasCommon=`${webglFingerprint}\n${canvasFingerprint}\nconst firstCanvasPromise=canvasFingerprint(true);\n`;
workerScripts['/canvas-dedicated.js']=canvasCommon+"firstCanvasPromise.then(data=>postMessage(data),error=>postMessage({error:String(error)}));";
workerScripts['/canvas-shared.js']=canvasCommon+"onconnect=e=>firstCanvasPromise.then(data=>e.ports[0].postMessage(data),error=>e.ports[0].postMessage({error:String(error)}));";
workerScripts['/canvas-service.js']=canvasCommon+"self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(firstCanvasPromise.then(data=>e.ports[0].postMessage(data),error=>e.ports[0].postMessage({error:String(error)}))));";
async function fixture(){
 const server=http.createServer((req,res)=>{
  const headers={'Content-Type':req.url==='/headers'?'application/json':workerScripts[req.url]?'application/javascript':'text/html','Cache-Control':'no-store','Accept-CH':'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Device-Memory, Sec-CH-Device-Memory'};
  const firstCanvasHTML=`<!doctype html><html><body>First-script Canvas fixture<script>${webglFingerprint}\n${canvasFingerprint}\nwindow.firstCanvasPromise=canvasFingerprint(false);</script></body></html>`;
  res.writeHead(200,headers);res.end(req.url==='/headers'?JSON.stringify(req.headers):workerScripts[req.url] || (req.url.startsWith('/canvas-')?firstCanvasHTML:'<!doctype html><html><body>Fingerprint fixture</body></html>'));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://localhost:${server.address().port}/`};
}
async function ready(host,url){await host.navigate(url);for(let attempt=0;attempt<100;attempt++){if(await host.evaluate('document.readyState')==='complete')return;await delay(20);}throw new Error('Fingerprint fixture did not load');}
const workerExpressions={
 dedicated:"new Promise((resolve,reject)=>{const w=new Worker('/dedicated.js'),t=setTimeout(()=>{w.terminate();reject(new Error('Dedicated Worker did not complete'))},7000);w.onmessage=e=>{clearTimeout(t);w.terminate();resolve(e.data)};w.onerror=e=>{clearTimeout(t);w.terminate();reject(new Error(e.message))}})",
 shared:"new Promise((resolve,reject)=>{const w=new SharedWorker('/shared.js'),t=setTimeout(()=>{w.port.close();reject(new Error('Shared Worker did not complete'))},7000);w.port.onmessage=e=>{clearTimeout(t);w.port.close();resolve(e.data)};w.onerror=e=>{clearTimeout(t);w.port.close();reject(new Error(e.message))};w.port.start()})",
 service:"Promise.race([(async()=>{const r=await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;const data=await new Promise((resolve,reject)=>{const c=new MessageChannel(),t=setTimeout(()=>reject(new Error('Service Worker did not respond')),5000);c.port1.onmessage=e=>{clearTimeout(t);resolve(e.data)};r.active.postMessage('collect',[c.port2])});await r.unregister();return data})(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Service Worker registration did not complete')),7000))])",
};
function comparableNavigator(value){return Object.fromEntries(['userAgent','platform','hardwareConcurrency','deviceMemory','language','languages','timezone','brands','mobile','uaPlatform','highEntropy'].map(key=>[key,value[key]]));}
function coherentHeaders(nav,headers,requireHints=true){
 assert.equal(headers['user-agent'],nav.userAgent,'network UA equals JS UA');
 for(const name of ['device-memory','sec-ch-device-memory'])if(headers[name]!==undefined)assert.equal(Number(headers[name]),nav.deviceMemory,`${name} matches configured memory`);
 if(!requireHints && !headers['sec-ch-ua-platform']){
  assert.equal(Object.keys(headers).some(key=>key.startsWith('sec-ch-ua')),false,'native worker request omits the complete UA-CH family');
  return;
 }
 assert.equal(JSON.parse(headers['sec-ch-ua-platform']),nav.uaPlatform,'network CH platform equals JS CH');
 assert.equal(JSON.parse(headers['sec-ch-ua-arch']),nav.highEntropy.architecture);
 assert.equal(JSON.parse(headers['sec-ch-ua-bitness']),nav.highEntropy.bitness);
 assert.equal(JSON.parse(headers['sec-ch-ua-platform-version']),nav.highEntropy.platformVersion);
 for(const brand of nav.highEntropy.fullVersionList)assert.ok(headers['sec-ch-ua-full-version-list'].includes(`"${brand.brand}";v="${brand.version}"`),'network and JS CH full versions agree');
}

test('native default fingerprints remain stable across restarts and new same-seed directories',{skip:process.platform!=='win32',timeout:90000},async()=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-fingerprint-stability-'));const {server,url}=await fixture();const hosts=[];
 const collect=async profile=>{const host=new NativeHost({profile,binaryPath,dataRoot});hosts.push(host);await host.initialize();await ready(host,url);const first=summarize(await host.evaluate(pageExpression)),repeat=summarize(await host.evaluate(pageExpression));await host.close();return {first,repeat};};
 try{
  const a=await collect(base),restarted=await collect(base),fresh=await collect({...base,id:'audit-fresh'}),b=await collect({...base,id:'audit-different',fingerprintSeed:987654321});
  for(const sample of [a,restarted,fresh,b]){
   assert.equal(sample.first.audio.sampleHash,sample.first.audio.repeatHash);assert.equal(sample.first.audio.sampleHash,sample.first.audio.copyHash,'Audio copyFromChannel and getChannelData agree');
   for(const key of ['audio','fonts','rect','webgl','navigator'])assert.equal(hash(sample.first[key]),hash(sample.repeat[key]),`${key} repeats consistently`);
   assert.ok([0.25,0.5,1,2,4,8].includes(sample.first.navigator.deviceMemory),'deviceMemory has a valid Chromium bucket');
   for(const type of ['webgl','webgl2']){const gl=sample.first.webgl[type];assert.equal(gl.available,true);assert.equal(gl.error,0);assert.equal(gl.pixelHash,gl.repeatPixelHash);assert.ok(gl.nonZeroBytes>0,'readPixels contains rendered content');}
  }
  for(const key of ['audio','fonts','rect','webgl','navigator']){
   assert.equal(hash(a.first[key]),hash(restarted.first[key]),`${key} stable after same-directory restart`);
   assert.equal(hash(a.first[key]),hash(fresh.first[key]),`${key} stable in fresh same-seed directory`);
  }
  assert.notEqual(a.first.audio.sampleHash,b.first.audio.sampleHash);assert.notEqual(a.first.fonts.hash,b.first.fonts.hash);assert.notEqual(a.first.rect.hash,b.first.rect.hash);
  assert.notEqual(a.first.webgl.webgl.unmaskedRenderer,b.first.webgl.webgl.unmaskedRenderer,'native GPU metadata varies across these seeds');
  console.log('Fingerprint runtime capabilities',JSON.stringify({canvasMode:'compatibility',deviceMemory:a.first.navigator.deviceMemory,webglPixelsDiffer:a.first.webgl.webgl.pixelHash!==b.first.webgl.webgl.pixelHash,elementRectsDiffer:hash(a.first.rect.elementClient)!==hash(b.first.rect.elementClient),rangeRectsDiffer:hash(a.first.rect.rangeClient)!==hash(b.first.rect.rangeClient)}));
 }finally{await closeHosts(hosts);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});

test('page and dedicated/shared/service Workers keep default and custom Chrome UA/CH coherent',{skip:process.platform!=='win32',timeout:90000},async()=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-fingerprint-workers-'));const {server,url}=await fixture();const hosts=[];
 const variants=[base,{...base,id:'audit-custom-UA',fingerprintSeed:987654321,hardwareConcurrency:12,memoryGiB:8,locale:'en-US',timezone:'America/New_York',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7620.10 Safari/537.36'},{...base,id:'audit-arbitrary-UA',userAgent:'PeregrineCustomAudit/1.0'}];
 try{
  for(const profile of variants){
   const host=new NativeHost({profile,binaryPath,dataRoot});hosts.push(host);await host.initialize();await ready(host,url);
   const page=await host.evaluate(`(${navigatorFingerprint})()`),pageGL=summarize({webgl:await host.evaluate(`(${webglFingerprint})()`)}).webgl;
   const chromeUA=!profile.userAgent || /Chrome\//u.test(profile.userAgent);
   coherentHeaders(page,await host.evaluate("fetch('/headers').then(r=>r.json())"),chromeUA);assert.equal(page.hardwareConcurrency,profile.hardwareConcurrency);assert.equal(page.deviceMemory,profile.memoryGiB);assert.equal(page.timezone,profile.timezone);assert.equal(page.language,profile.locale);
   if(chromeUA){const expectedVersion=profile.userAgent?.match(/Chrome\/([\d.]+)/u)?.[1] || (await host.cdp.send('Browser.getVersion')).product.split('/')[1];assert.equal(page.highEntropy.uaFullVersion,expectedVersion,'UA-CH full version matches the configured UA or default running core');}
   else {assert.equal(page.highEntropy,null);assert.equal(await host.evaluate('typeof navigator.userAgentData'),'undefined','arbitrary non-Chrome UA does not expose contradictory Chrome hints');}
   if(profile.id==='audit-custom-UA'){assert.equal(page.platform,'MacIntel');assert.equal(page.uaPlatform,'macOS');assert.equal(page.highEntropy.platformVersion,'14.5');}
   for(const [kind,expression] of Object.entries(workerExpressions)){
    const worker=await host.evaluate(expression);assert.equal(worker.error,undefined,`${kind} worker completed`);
    assert.deepEqual(comparableNavigator(worker.navigator),comparableNavigator(page),`${kind} navigator equals page`);
    for(const [key,value] of Object.entries(worker.firstNavigator))assert.deepEqual(value,page[key],`${kind} ${key} is already configured at first script execution`);
    coherentHeaders(worker.navigator,worker.headers,false);
    assert.deepEqual(summarize({webgl:worker.webgl}).webgl,pageGL,`${kind} OffscreenCanvas WebGL equals page rendering`);
   }
   await host.close();
  }
 }finally{await closeHosts(hosts);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});

const defaultSearchExpression="(()=>{let page;function walk(root){for(const el of root.querySelectorAll('*')){if(el.tagName==='SETTINGS-SEARCH-PAGE')page=el;if(el.shadowRoot)walk(el.shadowRoot)}}walk(document);return page?.defaultSearchEngine_})()";
async function searchSettings(host){await host.cdp.send('Page.navigate',{url:'chrome://settings/searchEngines'},await host.session());for(let i=0;i<100;i++){const engine=await host.evaluate(defaultSearchExpression);if(engine)return engine;await delay(20);}throw new Error('Native search settings did not initialize');}
test('native search defaults persist while a browser manual choice is preserved; virtual location allows or denies',{skip:process.platform!=='win32',timeout:90000},async()=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-search-location-'));const {server,url}=await fixture();const hosts=[];
 const profile={...base,id:'search-and-location',latitude:35.6762,longitude:139.6503,locationMode:'allow'};
 const open=async p=>{const host=new NativeHost({profile:p,binaryPath,dataRoot});hosts.push(host);await host.initialize();return host;};
 const geoExpression="new Promise(resolve=>navigator.geolocation.getCurrentPosition(p=>resolve({coordinates:[p.coords.latitude,p.coords.longitude],accuracy:p.coords.accuracy}),e=>resolve({error:e.code}),{timeout:4000,maximumAge:0}))";
 try{
  const host=await open(profile);assert.equal((await searchSettings(host)).keyword,'bing.com','configured native omnibox provider is Bing');
  // Use Chromium's own native search handler in this test-only profile.
  const manual=await host.evaluate("(()=>{let selected;function walk(root){for(const el of root.querySelectorAll('*')){if(el.tagName==='SETTINGS-SEARCH-ENGINE-ENTRY'&&el.engine?.canBeDefault&&el.engine.keyword!=='bing.com'&&!selected)selected=el;if(el.shadowRoot)walk(el.shadowRoot)}}walk(document);if(!selected)throw new Error('Manual choice fixture unavailable');selected.onMakeDefaultClick_();return selected.engine.keyword})()");
  await delay(100);assert.equal((await host.evaluate(defaultSearchExpression)).keyword,manual);
  await ready(host,url);assert.deepEqual((await host.evaluate(geoExpression)).coordinates,[35.6762,139.6503]);
  const tab=await host.newTab(url+'new');for(let i=0;i<100 && await host.evaluate('document.readyState',tab)!=='complete';i++)await delay(20);
  assert.deepEqual((await host.evaluate(geoExpression,tab)).coordinates,[35.6762,139.6503],'new native tab receives configured position');
  const crossOrigin=new URL(url);crossOrigin.hostname='127.0.0.1';crossOrigin.pathname='/geo-frame';
  await host.evaluate(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.allow='geolocation *';frame.onload=()=>resolve(true);frame.src=${JSON.stringify(crossOrigin.href)};document.body.append(frame)})`,tab);
  let frame;for(let i=0;i<100;i++){frame=(await host.cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='iframe'&&t.url===crossOrigin.href);if(frame)break;await delay(20);}assert.ok(frame,'cross-origin geolocation frame is attached');
  assert.deepEqual((await host.evaluate(geoExpression,frame.targetId)).coordinates,[35.6762,139.6503],'cross-origin permitted frame receives configured position');
  await host.close();const restarted=await open(profile);assert.equal((await searchSettings(restarted)).keyword,manual,'unchanged application config preserves manual native browser choice');await restarted.close();
  const denied=await open({...profile,id:'location-blocked',locationMode:'block'});await ready(denied,url);assert.equal((await denied.evaluate(geoExpression)).error,1,'block mode reports PERMISSION_DENIED');assert.equal(await denied.evaluate("navigator.permissions.query({name:'geolocation'}).then(p=>p.state)"),'denied');await denied.close();
 }finally{await closeHosts(hosts);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});

test('native Google DuckDuckGo and Baidu search providers are selected in Chromium settings',{skip:process.platform!=='win32',timeout:90000},async()=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-search-providers-'));const hosts=[];
 try{for(const [searchEngine,keyword] of [['google','google.com'],['duckduckgo','duckduckgo.com'],['baidu','baidu.com']]){
  const host=new NativeHost({profile:{...base,id:`search-${searchEngine}`,searchEngine},binaryPath,dataRoot});hosts.push(host);await host.initialize();const engine=await searchSettings(host);assert.equal(engine.keyword,keyword);assert.equal(engine.default,true);assert.ok(engine.url.startsWith('https://'));assert.ok(engine.url.includes('%s') || engine.url.includes('{searchTerms}'));await host.close();
 }}finally{await closeHosts(hosts);await fs.rm(dataRoot,{recursive:true,force:true});}
});

function decodePNG(bytes){
 const png=Buffer.from(bytes);assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));const parts=[];let width,height;
 for(let at=8;at<png.length;){const size=png.readUInt32BE(at),type=png.toString('ascii',at+4,at+8),body=png.subarray(at+8,at+8+size);if(type==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);assert.equal(body[8],8);assert.equal(body[9],6);}if(type==='IDAT')parts.push(body);at+=size+12;}
 const packed=inflateSync(Buffer.concat(parts)),rowBytes=width*4,raw=Buffer.alloc(rowBytes*height);
 for(let y=0;y<height;y++){const filter=packed[y*(rowBytes+1)];for(let x=0;x<rowBytes;x++){const at=y*rowBytes+x,value=packed[y*(rowBytes+1)+x+1],left=x>=4?raw[at-4]:0,up=y?raw[at-rowBytes]:0,upperLeft=y&&x>=4?raw[at-rowBytes-4]:0;let predict=0;if(filter===1)predict=left;else if(filter===2)predict=up;else if(filter===3)predict=Math.floor((left+up)/2);else if(filter===4){const p=left+up-upperLeft,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-upperLeft);predict=a<=b&&a<=c?left:b<=c?up:upperLeft;}else assert.equal(filter,0);raw[at]=(value+predict)&255;}}
 return Array.from(raw);
}
function canvasSummary(result,seed){
 assert.equal(result.error,undefined);assert.equal(result.layer?.javascriptLayer,true);assert.equal(result.layer?.seed,seed,'pixel policy is installed before the first script');
 const images={};for(const name of ['html','offscreen'])if(result[name]){const image=result[name];assert.deepEqual(image.raw,image.repeat,'raw read does not accumulate changes');assert.deepEqual(decodePNG(image.blob),image.raw,'independent Node PNG decode equals raw readback');if(image.dataURL)assert.deepEqual(decodePNG(Buffer.from(image.dataURL.split(',')[1],'base64')),image.raw);images[name]={raw:hash(image.raw),png:hash(image.blob)};}
 const webgl=summarize({webgl:result.webgl}).webgl;for(const gl of Object.values(webgl)){assert.equal(gl.error,0);assert.equal(gl.pixelHash,gl.repeatPixelHash);}return {images,webgl};
}
test('stable pixel policy applies before page/frame/worker scripts and persists across restarts',{skip:process.platform!=='win32',timeout:120000},async()=>{
 const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-stable-pixels-'));const {server,url}=await fixture();const hosts=[];
 const open=async p=>{const h=new NativeHost({profile:{...base,canvasMode:'stable',...p},binaryPath,dataRoot});hosts.push(h);await h.initialize();await ready(h,url+'canvas-main');return h;};
 try{
  const host=await open({id:'stable-a'}),first=canvasSummary(await host.evaluate('firstCanvasPromise'),base.fingerprintSeed);
  assert.deepEqual(first.images.html,first.images.offscreen,'HTML Canvas and OffscreenCanvas use the same pixel/PNG policy');
  for(const [kind,expression] of Object.entries(workerExpressions)){const script=expression.replace('/dedicated.js','/canvas-dedicated.js').replace('/shared.js','/canvas-shared.js').replace('/service.js','/canvas-service.js');const result=canvasSummary(await host.evaluate(script),base.fingerprintSeed);assert.deepEqual(result.images.offscreen,first.images.offscreen,`${kind} first-script Canvas matches page`);assert.deepEqual(result.webgl,first.webgl,`${kind} first-script WebGL matches page`);}
  const sameOrigin=await host.evaluate("new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=()=>frame.contentWindow.firstCanvasPromise.then(resolve);frame.src='/canvas-frame';document.body.append(frame)})");assert.deepEqual(canvasSummary(sameOrigin,base.fingerprintSeed),first,'same-origin first-script pixel policy matches page');
  const crossOrigin=new URL(url+'canvas-frame');crossOrigin.hostname='127.0.0.1';await host.evaluate(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=()=>resolve(true);frame.src=${JSON.stringify(crossOrigin.href)};document.body.append(frame)})`);
  let frame;for(let i=0;i<100;i++){frame=(await host.cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='iframe'&&t.url===crossOrigin.href);if(frame)break;await delay(20);}assert.ok(frame);assert.deepEqual(canvasSummary(await host.evaluate('firstCanvasPromise',frame.targetId),base.fingerprintSeed),first,'OOPIF first-script pixel policy matches page');
  await host.close();const restart=await open({id:'stable-a'});assert.deepEqual(canvasSummary(await restart.evaluate('firstCanvasPromise'),base.fingerprintSeed),first,'same profile pixel/PNG results survive process restart');await restart.close();
  const fresh=await open({id:'stable-a-fresh'});assert.deepEqual(canvasSummary(await fresh.evaluate('firstCanvasPromise'),base.fingerprintSeed),first,'fresh same-seed profile has the same pixel/PNG results');await fresh.close();
  const other=await open({id:'stable-b',fingerprintSeed:987654321}),different=canvasSummary(await other.evaluate('firstCanvasPromise'),987654321);assert.notEqual(different.images.html.raw,first.images.html.raw);assert.notEqual(different.webgl.webgl.pixelHash,first.webgl.webgl.pixelHash);await other.close();
  console.log('Stable pixel policy proof',JSON.stringify({sameSeedCanvas:first.images.html.raw,otherSeedCanvas:different.images.html.raw,sameSeedWebGL:first.webgl.webgl.pixelHash,otherSeedWebGL:different.webgl.webgl.pixelHash}));
 }finally{await closeHosts(hosts);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});
