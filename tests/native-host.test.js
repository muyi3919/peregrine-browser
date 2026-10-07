'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {PassThrough}=require('node:stream');
const {CdpPipe}=require('../src/cdp-pipe');
const {NativeHost,launchArguments}=require('../src/native-host');
const binaryPath=path.resolve(__dirname,'../vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64/chrome.exe');
const base={id:'native-a',canvasMode:'native',fingerprintSeed:123456789,hardwareConcurrency:4,locale:'ja-JP',timezone:'Asia/Tokyo',latitude:35.6762,longitude:139.6503,locationMode:'allow',homepage:'about:blank',security:{webrtc:'proxy',httpsOnly:false,blockThirdPartyCookies:true,camera:'block',microphone:'block',notifications:'block'}};

test('pipe CDP frames fragments, routes results and closes outstanding commands',async()=>{
  const input=new PassThrough(),output=new PassThrough();const pipe=new CdpPipe(input,output);
  let sent;input.once('data',chunk=>{sent=JSON.parse(chunk.subarray(0,-1));});
  const result=pipe.send('Browser.getVersion');assert.equal(sent.method,'Browser.getVersion');
  output.write('{"id":1,"result":');output.write('{"product":"Chrome/150"}}\0');
  assert.deepEqual(await result,{product:'Chrome/150'});
  const pending=pipe.send('Target.getTargets');pipe.close();await assert.rejects(pending,/关闭/u);
});
test('native arguments preserve security boundaries and native fingerprint flags',()=>{
  const args=launchArguments(base,31280,'C:/test/profile');
  assert.ok(args.includes('--fingerprint=123456789'));assert.ok(args.includes('--fingerprint-hardware-concurrency=4'));
  assert.ok(args.includes('--remote-debugging-pipe'));assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(!args.some(arg=>arg.startsWith('--remote-debugging-port')));assert.ok(!args.includes('--no-sandbox'));assert.ok(!args.includes('--ignore-certificate-errors'));
  assert.ok(launchArguments(base,undefined,'C:/test/direct').includes('--no-proxy-server'));
  assert.ok(launchArguments({...base,canvasMode:'compatibility'},undefined,'C:/test/direct').includes('--disable-spoofing=canvas'));
});

test('closing during initialization cancels before launch and reports close once',async()=>{
  let entered,release,notifications=0;
  const preflight=new Promise(resolve=>{entered=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const host=new NativeHost({profile:base,binaryPath:process.execPath,dataRoot:os.tmpdir(),onClose:()=>{notifications++;}});
  host.preferences=async()=>{entered();await wait;};host.extension=async()=>null;
  const initializing=host.initialize();await preflight;
  await host.close();release();
  await assert.rejects(initializing,/取消/u);
  assert.equal(host.child,null);assert.equal(host.isAlive,false);assert.equal(notifications,1);
  await host.close();await assert.rejects(host.initialize(),/取消/u);assert.equal(notifications,1);
});

test('native security applies to new tabs and child frames, branded home and HTTP rejection',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-native-security-'));
  const source=path.join(dataRoot,'home-source');await fs.mkdir(source);await fs.writeFile(path.join(source,'home.html'),'<!doctype html><html><head></head><body><h1>游隼测试首页</h1></body></html>');
  let httpRequests=0,connectRequests=0;const agents=[];
  const server=http.createServer((req,res)=>{httpRequests++;agents.push(req.headers['user-agent']);res.writeHead(200,{'Content-Type':'text/html',...(req.url.includes('/third-cookie')?{'Set-Cookie':'thirdPartyProof=1;Path=/;Max-Age=3600;SameSite=None;Secure'}:{})});res.end('<!doctype html><html><body>security fixture</body></html>');});
  server.on('connect',(req,socket)=>{connectRequests++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const proxyPort=server.address().port;
  const profile={...base,id:'security',name:'Environment "安全" <test>',userAgent:'PeregrineNativeTest/1.0',homepage:'peregrine://home/',security:{...base.security,webrtc:'block'}};
  const host=new NativeHost({profile,proxyPort,binaryPath,dataRoot,homepagePath:path.join(source,'home.html')});
  let strict,cookieControl;
  try{
    await host.initialize();
    assert.equal(await host.evaluate('JSON.parse(document.querySelector(\'meta[name="peregrine-environment"]\').content).name'),profile.name);
    const first=await host.newTab(fixture+'/');await ready(host,fixture+'/',first);
    assert.deepEqual(await host.evaluate("[typeof RTCPeerConnection,navigator.userAgent]",first),['undefined','PeregrineNativeTest/1.0']);
    assert.deepEqual(await host.evaluate("Promise.all(['camera','microphone','notifications'].map(name=>navigator.permissions.query({name}).then(p=>p.state)))",first),['denied','denied','denied']);
    const frame=await host.evaluate("new Promise(resolve=>{const f=document.createElement('iframe');f.onload=()=>resolve([typeof f.contentWindow.RTCPeerConnection,f.contentWindow.navigator.userAgent]);f.srcdoc='<body>same-origin frame</body>';document.body.append(f)})",first);
    assert.deepEqual(frame,['undefined','PeregrineNativeTest/1.0']);
    await host.evaluate("new Promise(resolve=>{const f=document.createElement('iframe');f.onload=resolve;f.src='http://127.0.0.1:23992/frame';document.body.append(f)})",first);
    let iframe;
    for(let i=0;i<50;i++) {iframe=(await host.cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='iframe'&&t.url.includes('23992'));if(iframe)break;await new Promise(resolve=>setTimeout(resolve,30));}
    assert.ok(iframe,'cross-origin iframe is controlled');
    assert.deepEqual(await host.evaluate("[typeof RTCPeerConnection,navigator.userAgent,Intl.DateTimeFormat().resolvedOptions().timeZone]",iframe.targetId),['undefined','PeregrineNativeTest/1.0','Asia/Tokyo']);
    assert.ok(agents.every(agent=>agent==='PeregrineNativeTest/1.0'));
    const workerProbe="new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([\"fetch('http://localhost:23991/worker-probe',{mode:'no-cors'}).then(()=>postMessage('allowed'),()=>postMessage('blocked'))\"],{type:'application/javascript'}));const worker=new Worker(url);const timer=setTimeout(()=>{worker.terminate();reject(new Error('worker timeout'))},6000);worker.onmessage=e=>{clearTimeout(timer);worker.terminate();resolve(e.data)};worker.onerror=e=>{clearTimeout(timer);worker.terminate();reject(new Error('worker startup failure'))}})";
    const baselineRequests=httpRequests;assert.equal(await host.evaluate(workerProbe,first),'allowed');assert.ok(httpRequests>baselineRequests,'control worker performs HTTP');
    await host.show();await host.focus();
    strict=new NativeHost({profile:{...base,id:'https-only',security:{...base.security,httpsOnly:true}},proxyPort,binaryPath,dataRoot});await strict.initialize();
    const prior=httpRequests;await assert.rejects(strict.navigate(fixture+'/'),/加载失败/u);assert.equal(httpRequests,prior,'HTTP request must not reach the proxy');
    const strictSession=await strict.session();
    const mainFrameResult=await strict.cdp.send('Page.navigate',{url:fixture+'/direct-main-frame'},strictSession);
    assert.ok(mainFrameResult.errorText,'direct CDP main-frame HTTP navigation is blocked');
    assert.equal(httpRequests,prior,'DNR main-frame rule prevents HTTP before the proxy');
    await strict.navigate('about:blank');const beforeWorker=httpRequests;
    assert.equal(await strict.evaluate(workerProbe),'blocked');assert.equal(httpRequests,beforeWorker,'strict worker cannot send HTTP');
    const beforeSockets=connectRequests;
    assert.equal(await strict.evaluate("new Promise(resolve=>{const socket=new WebSocket('ws://localhost:23991/socket');socket.onerror=()=>resolve('blocked');socket.onopen=()=>{socket.close();resolve('allowed')};setTimeout(()=>{socket.close();resolve('timeout')},5000)})"),'blocked');
    assert.equal(connectRequests,beforeSockets,'strict websocket cannot send ws CONNECT');
    const settings=JSON.parse(await fs.readFile(path.join(host.directory,'Default','Preferences'),'utf8'));
    assert.equal(settings.profile.block_third_party_cookies,true);
    cookieControl=new NativeHost({profile:{...base,id:'cookie-control',canvasMode:'compatibility',security:{...base.security,blockThirdPartyCookies:false}},proxyPort,binaryPath,dataRoot});await cookieControl.initialize();await ready(cookieControl,fixture+'/');
    const loadThirdParty="new Promise(resolve=>{const f=document.createElement('iframe');f.onload=()=>resolve(true);f.src='http://one.localhost:23993/third-cookie';document.body.append(f)})";
    await cookieControl.evaluate(loadThirdParty);await host.evaluate(loadThirdParty,first);
    const allowed=(await cookieControl.cdp.send('Storage.getCookies')).cookies.some(cookie=>cookie.name==='thirdPartyProof');
    const blocked=(await host.cdp.send('Storage.getCookies')).cookies.some(cookie=>cookie.name==='thirdPartyProof');
    console.log('Native third-party cookie proof',JSON.stringify({controlAllowed:allowed,policyStored:blocked}));
    assert.equal(allowed,true,'control accepts secure cookie from localhost third-party iframe');assert.equal(blocked,false,'block setting rejects third-party cookie');
    assert.equal(await cookieControl.evaluate("(()=>{const c=document.createElement('canvas');c.width=300;c.height=80;const ctx=c.getContext('2d');ctx.fillStyle='#069';ctx.fillRect(3,4,170,45);return ctx.getImageData(0,0,300,80).data.length})()"),96000,'default compatibility path returns native raw pixel data');
  }catch(error){console.error('Native security diagnostic',host.lastError || strict?.lastError || cookieControl?.lastError);throw error;}finally{await host.close();await strict?.close();await cookieControl?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});
const fingerprintExpression=`(async()=>{
 await document.fonts.ready;
 const c=document.createElement('canvas');c.width=300;c.height=80;const x=c.getContext('2d');
 x.fillStyle='#f60';x.fillRect(17,4,125,46);x.font='18px Arial';x.fillStyle='#069';x.fillText('Peregrine Canvas 123456789',5,27);x.globalCompositeOperation='multiply';x.fillStyle='rgba(100,200,50,.7)';x.beginPath();x.arc(90,38,25,0,Math.PI*2);x.fill();
 const d=document.createElement('div');d.style.cssText='position:absolute;left:12.123px;top:27.819px;width:127.317px;height:49.182px;font:17.143px Arial;transform:rotate(.123deg)';d.textContent='Rect ABCD';document.body.append(d);const range=document.createRange();range.selectNodeContents(d);const rect=[...d.getClientRects(),...range.getClientRects()].map(r=>[r.x,r.y,r.width,r.height,r.top,r.right,r.bottom,r.left]);d.remove();
 const ac=new OfflineAudioContext(1,44100,44100);const o=ac.createOscillator(),co=ac.createDynamicsCompressor();o.type='triangle';o.frequency.value=10000;co.threshold.value=-50;co.knee.value=40;co.ratio.value=12;co.attack.value=0;co.release.value=.25;o.connect(co);co.connect(ac.destination);o.start(0);const buffer=await ac.startRendering();const audio=Array.from(buffer.getChannelData(0).slice(4500,5000));
 return {canvas:c.toDataURL(),audio,rect,cores:navigator.hardwareConcurrency,language:navigator.language,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,ua:navigator.userAgent,brands:navigator.userAgentData?.brands,webdriver:navigator.webdriver};
})()`;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixture='http://localhost:23991';
async function ready(host,url,targetId){await host.navigate(url,targetId);for(let count=0;count<100;count++){if(await host.evaluate('document.readyState',targetId)==='complete')return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Fixture page not ready');}

test('real native seeds isolate fingerprints, region and storage; report restart stability',{skip:process.platform!=='win32',timeout:120000},async()=>{
  await fs.access(binaryPath);
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'peregrine-native-test-'));
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body><h1>Native fixture</h1></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const proxyPort=server.address().port;
  const hosts=[];
  const open=async profile=>{const h=new NativeHost({profile,proxyPort,binaryPath,dataRoot});hosts.push(h);await h.initialize();return h;};
  try{
    const a=await open(base);await ready(a,fixture+'/');
    const first=await a.evaluate(fingerprintExpression),repeat=await a.evaluate(fingerprintExpression);
    for(const key of ['canvas','audio','rect'])assert.equal(digest(first[key]),digest(repeat[key]),`${key} stable within one profile`);
    assert.equal(first.cores,4);assert.equal(first.language,'ja-JP');assert.equal(first.timezone,'Asia/Tokyo');assert.equal(first.webdriver,false);
    await a.evaluate("localStorage.setItem('profile-secret','A');document.cookie='profileCookie=A;path=/;max-age=3600'");
    const geo=await a.evaluate("new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve([p.coords.latitude,p.coords.longitude]),reject))");assert.deepEqual(geo,[35.6762,139.6503]);
    const b=await open({...base,id:'native-b',fingerprintSeed:987654321,hardwareConcurrency:12,locale:'en-US',timezone:'America/New_York'});await ready(b,fixture+'/');
    const different=await b.evaluate(fingerprintExpression);assert.equal(different.cores,12);assert.equal(different.language,'en-US');assert.equal(different.timezone,'America/New_York');
    for(const key of ['canvas','audio','rect'])assert.notEqual(digest(first[key]),digest(different[key]),`${key} differs across native seeds`);
    assert.deepEqual(await b.evaluate("[localStorage.getItem('profile-secret'),document.cookie]"),[null,'']);
    await a.close();assert.equal(a.isAlive,false);
    const restarted=await open(base);await ready(restarted,fixture+'/');const persisted=await restarted.evaluate(fingerprintExpression);
    console.log('Native restart stability',JSON.stringify(Object.fromEntries(['canvas','audio','rect'].map(k=>[k,{stable:digest(first[k])===digest(persisted[k]),firstHash:digest(first[k]),restartHash:digest(persisted[k])}]))));
    for(const key of ['audio','rect'])assert.equal(digest(first[key]),digest(persisted[key]),`${key} stable across browser restart`);
    // The shipped upstream 150 binary changes Canvas.toDataURL across process
    // restarts on this host. We record that limitation instead of substituting JS.
    assert.deepEqual(await restarted.evaluate("[localStorage.getItem('profile-secret'),document.cookie]"),['A','profileCookie=A']);
    const targetId=await restarted.newTab(fixture+'/new');await ready(restarted,fixture+'/new',targetId);
    assert.equal(await restarted.evaluate('navigator.hardwareConcurrency',targetId),4);
    assert.ok((await restarted.screenshot(targetId)).length>1000);
    console.log('Native verified hashes',JSON.stringify(Object.fromEntries(['canvas','audio','rect'].map(k=>[k,{seedA:digest(first[k]),seedB:digest(different[k])}]))));
  }catch(error){console.log('Native failure state',hosts.map(h=>({id:h.profile.id,error:h.lastError?.message,exitCode:h.child?.exitCode})));throw error;}finally{for(const h of hosts)await h.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataRoot,{recursive:true,force:true});}
});
