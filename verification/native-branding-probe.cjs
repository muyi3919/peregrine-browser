'use strict';

// Audit only a newly launched, isolated browser. No installed application or
// existing profile is inspected, modified, or closed by this script.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const ResEdit = require('resedit');
const { NativeHost } = require('../src/native-host');
const { PRODUCT_NAME, APP_USER_MODEL_ID, startNativeWindowBranding, inspectNativeWindows } = require('../src/native-brand-window');

const ROOT = path.resolve(__dirname, '..');
const BRANDED_BINARY = path.join(ROOT, 'vendor/peregrine-chromium/runtime/chrome.exe');
const ICON = path.join(ROOT, 'ui/assets/peregrine.ico');
const RELAUNCH = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function imagePixels(host, dataUrl) {
  return host.evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify(dataUrl)};await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);const bytes=context.getImageData(0,0,canvas.width,canvas.height).data;let value=2166136261;for(const byte of bytes)value=Math.imul(value^byte,16777619)>>>0;return {width:canvas.width,height:canvas.height,pixelFnv:value};})()`);
}

const SNAPSHOT = `(() => {
  if (!document.documentElement || !document.body) return {url:location.href,readyState:document.readyState,texts:[],documentPending:true};
  const texts = [], headings = [], images = [], productGlyphs=[],links=[],aboutFields={};let aboutLayout;
  const seen = new Set();
  function visit(root) {
    if (seen.has(root)) return; seen.add(root);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent && !['STYLE','SCRIPT'].includes(parent.tagName) && parent.getClientRects().length) {
          const text = node.textContent.trim(); if (text) texts.push(text);
        }
      } else {
        if (/^H[1-6]$/.test(node.tagName) && node.getClientRects().length) headings.push(node.textContent.trim());
        if (node.tagName === 'IMG') images.push({src:node.src,currentSrc:node.currentSrc,srcset:node.srcset,alt:node.alt,width:node.naturalWidth,height:node.naturalHeight,visible:!!node.getClientRects().length,html:node.outerHTML,parent:node.parentElement?.outerHTML.slice(0,1800)});
        if (node.tagName === 'A' && node.getClientRects().length) links.push({text:node.textContent.trim(),href:node.href,target:node.target});
        for(const field of ['app-version','engine','manual-update','core-copyright'])if(node.hasAttribute('data-peregrine-'+field)){const r=node.getBoundingClientRect();aboutFields[field]={text:node.textContent.trim(),visible:!!node.getClientRects().length,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};}
        if(node.hasAttribute('data-peregrine-about')){
          const r=node.getBoundingClientRect(),ancestors=[];let parent=node;
          while(parent){const box=parent.getBoundingClientRect(),style=getComputedStyle(parent);ancestors.push({tag:parent.tagName,id:parent.id,clientWidth:parent.clientWidth,scrollWidth:parent.scrollWidth,clientHeight:parent.clientHeight,scrollHeight:parent.scrollHeight,left:box.left,right:box.right,minWidth:style.minWidth,maxWidth:style.maxWidth,computedWidth:style.width,overflowX:style.overflowX,overflowY:style.overflowY});parent=parent.parentElement||parent.getRootNode().host;}
          aboutLayout={clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,left:r.left,right:r.right,width:r.width,ancestors};
        }
        if (['CR-ICON','IRON-ICON'].includes(node.tagName) && node.icon === 'cr:chrome-product' && node.getClientRects().length) productGlyphs.push({icon:node.icon,html:node.outerHTML,shadow:node.shadowRoot?.innerHTML});
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    }
  }
  visit(document);
  return {url:location.href,title:document.title,language:document.documentElement.lang,readyState:document.readyState,texts,headings,images,productGlyphs,links,aboutFields,aboutLayout,layout:{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}};
})()`;

function isNavigationContextMessage(message) {
  return typeof message==='string' && /^(?:Execution context was destroyed\b|Cannot find context with specified (?:unique )?id\b|Cannot find default execution context\b|Unique context id not found\b|Inspected target navigated or closed\b)/u.test(message);
}

async function navigationSnapshot(host, session) {
  let response;
  try {
    // NativeHost.evaluate intentionally hides page exception details. This
    // diagnostic needs those details to distinguish navigation from JS bugs.
    response=await host.cdp.send('Runtime.evaluate',{expression:SNAPSHOT,returnByValue:true,awaitPromise:true,userGesture:true},session);
  } catch(error) {
    if(error.protocolError?.code===-32000 && isNavigationContextMessage(error.protocolError.message))return null;
    throw error;
  }
  if(response.exceptionDetails){
    const details=response.exceptionDetails;
    // A real thrown JS exception (including SyntaxError/TypeError and its
    // stack) must remain fatal. Only the inspector's context-loss sentinel
    // without a JavaScript exception object is a retryable transition.
    if(!details.exception && isNavigationContextMessage(details.text))return null;
    const error=new Error('Branding snapshot execution failed: '+(details.exception?.description||details.text));
    error.exceptionDetails=details;
    throw error;
  }
  const snapshot=response.result?.value;
  if(!snapshot || typeof snapshot!=='object')throw new Error('Branding snapshot did not return an object.');
  return snapshot;
}

async function internalPage(host, url) {
  const session = await host.session();
  const navigation = await host.cdp.send('Page.navigate', { url }, session);
  if (navigation.errorText) throw new Error(`Internal page failed: ${url} ${navigation.errorText}`);
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    snapshot = await navigationSnapshot(host, session);
    if (snapshot && snapshot.url.startsWith(url) && snapshot.readyState === 'complete' && snapshot.texts.length > 3 &&
        (!url.includes('/help') || snapshot.texts.some(text => text.includes('150.0.7871.186')))) return snapshot;
    await pause(50);
  }
  throw new Error(`Internal page did not become ready: ${url} ${JSON.stringify(snapshot)}`);
}

async function waitImageMode(host, mode) {
  let snapshot;
  for(let i=0;i<100;i+=1){
    snapshot=await host.evaluate(SNAPSHOT);
    if(snapshot.images.some(image=>image.visible&&image.currentSrc.includes(mode)&&image.width>0))return snapshot;
    await pause(30);
  }
  await fs.writeFile(path.join(__dirname,'native-branding-failure.json'),JSON.stringify({mode,snapshot},null,2)+'\n');
  await fs.writeFile(path.join(__dirname,'native-branding-failure.png'),await host.screenshot());
  throw new Error('Native settings image mode failed: '+mode);
}

async function collectLiveBrandingEvidence({outputDir = __dirname, locales = ['en-US', 'zh-CN']} = {}) {
  await fs.access(BRANDED_BINARY);
  await fs.mkdir(outputDir, {recursive: true});
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-native-branding-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><html><head><title>Native branding audit</title></head><body><h1>Native branding audit</h1></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixture = `http://127.0.0.1:${server.address().port}/`;
  const report = {productName:PRODUCT_NAME,appUserModelId:APP_USER_MODEL_ID,binaryPath:BRANDED_BINARY,iconPath:ICON,locales:[],scope:'Only temporary profiles and their newly launched exact browser PIDs.',capturedAt:new Date().toISOString()};
  try {
    for (const locale of locales) {
      const host = new NativeHost({binaryPath:BRANDED_BINARY,dataRoot,profile:{
        id:`brand-${locale}`,fingerprintSeed:123456789,hardwareConcurrency:4,memoryGiB:4,
        canvasMode:'compatibility',locale,timezone:'Asia/Taipei',homepage:'about:blank',locationMode:'block',
        security:{httpsOnly:false,webrtc:'block',blockThirdPartyCookies:true,camera:'block',microphone:'block',notifications:'block'},
      }});
      let watcher;
      try {
        await host.initialize();
        const resourceRequests = new Set();
        const imageResponses = new Map();
        const pageErrors=[];
        host.cdp.on('event', event => {
          const url = event.params?.response?.url;
          if (event.method === 'Network.responseReceived' && url?.startsWith('chrome://')) resourceRequests.add(url);
          if (event.method === 'Network.responseReceived' && (url?.includes('current-channel-logo')||url?.includes('chrome_logo_dark.svg'))) imageResponses.set(url,{requestId:event.params.requestId,sessionId:event.sessionId});
          if(event.method==='Runtime.exceptionThrown')pageErrors.push({kind:'exception',details:event.params.exceptionDetails});
          if(event.method==='Log.entryAdded'&&event.params.entry.level==='error')pageErrors.push({kind:'log',entry:event.params.entry});
        });
        await host.cdp.send('Network.enable',{},await host.session());
        await host.cdp.send('Runtime.enable',{},await host.session());
        await host.cdp.send('Log.enable',{},await host.session());
        await host.navigate(fixture);
        for (let i = 0; i < 100 && await host.evaluate('document.title') !== 'Native branding audit'; i += 1) await pause(30);
        const before = await inspectNativeWindows({pid:host.child.pid,processPath:BRANDED_BINARY,iconPath:ICON});
        watcher = await startNativeWindowBranding({pid:host.child.pid,processPath:BRANDED_BINARY,iconPath:ICON,relaunchPath:RELAUNCH,relaunchArguments:[ROOT]});
        const branded = await inspectNativeWindows({pid:host.child.pid,processPath:BRANDED_BINARY,iconPath:ICON});
        const settings = await internalPage(host, 'chrome://settings/');
        const settingsScreenshot = path.join(outputDir, `native-branding-settings-${locale}.png`);
        await fs.writeFile(settingsScreenshot, await host.screenshot());
        const about = await internalPage(host, 'chrome://settings/help');
        const aboutScreenshot = path.join(outputDir, `native-branding-about-${locale}.png`);
        await fs.writeFile(aboutScreenshot, await host.screenshot());
        const aboutWindows = await inspectNativeWindows({pid:host.child.pid,processPath:BRANDED_BINARY,iconPath:ICON});
        const session=await host.session();
        await host.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},session);
        const darkAbout=await waitImageMode(host,'chrome_logo_dark.svg');
        const darkScreenshot=path.join(outputDir,`native-branding-about-dark-${locale}.png`);
        await fs.writeFile(darkScreenshot,await host.screenshot());
        await host.cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]},session);
        await host.cdp.send('Emulation.setDeviceMetricsOverride',{width:0,height:0,mobile:false,deviceScaleFactor:2},session);
        const about2x=await waitImageMode(host,'current-channel-logo@2x');
        const themeLogos = [];
        const icon = ResEdit.Data.IconFile.from(await fs.readFile(ICON));
        for (const [url,response] of imageResponses) {
          const body = await host.cdp.send('Network.getResponseBody',{requestId:response.requestId},response.sessionId);
          const bytes = Buffer.from(body.body,body.base64Encoded ? 'base64' : 'utf8');
          const actual = await imagePixels(host,'data:image/'+(url.endsWith('.svg')?'svg+xml':'png')+';base64,'+bytes.toString('base64'));
          const expectedImage = icon.icons.find(item => item.data.width === actual.width);
          const expected = await imagePixels(host,'data:image/png;base64,'+Buffer.from(expectedImage.data.bin).toString('base64'));
          themeLogos.push({url,actual,expected,match:JSON.stringify(actual)===JSON.stringify(expected)});
        }
        await host.cdp.send('Emulation.setDeviceMetricsOverride',{width:520,height:780,mobile:false,deviceScaleFactor:1},session);
        await host.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const narrowAbout=await host.evaluate(SNAPSHOT);
        const narrowScreenshot=path.join(outputDir,`native-branding-about-narrow-${locale}.png`);
        const fullNarrow=await host.cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:520,height:narrowAbout.layout.scrollHeight,scale:1}},session);
        await fs.writeFile(narrowScreenshot,Buffer.from(fullNarrow.data,'base64'));
        const scrollProof=await host.evaluate(`(()=>{let article;function find(root){for(const node of root.querySelectorAll('*')){if(node.hasAttribute('data-peregrine-about'))article=node;if(node.shadowRoot)find(node.shadowRoot);}}find(document);let parent=article;while(parent){const style=getComputedStyle(parent);if(['auto','scroll'].includes(style.overflowY)&&parent.scrollHeight>parent.clientHeight){parent.scrollTop=parent.scrollHeight;return {tag:parent.tagName,id:parent.id,scrollTop:parent.scrollTop,clientHeight:parent.clientHeight,scrollHeight:parent.scrollHeight};}parent=parent.parentElement||parent.getRootNode().host;}return null;})()`);
        await host.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const narrowFooter=await host.evaluate(SNAPSHOT);
        const narrowFooterScreenshot=path.join(outputDir,`native-branding-about-narrow-footer-${locale}.png`);
        await fs.writeFile(narrowFooterScreenshot,await host.screenshot());
        report.locales.push({locale,profileDirectory:host.directory,processId:host.child.pid,before,branded,settings,about,darkAbout,about2x,narrowAbout,narrowFooter,scrollProof,aboutWindows,themeLogos,pageErrors,resourceRequests:[...resourceRequests],settingsScreenshot,aboutScreenshot,darkScreenshot,narrowScreenshot,narrowFooterScreenshot,browserVersion:await host.cdp.send('Browser.getVersion')});
      } finally {
        // WM_SETICON handles are owned by the helper until the window exits.
        await host.close();
        await watcher?.close();
      }
    }
    await fs.writeFile(path.join(outputDir, 'native-branding-live.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // This absolute directory was freshly created by this invocation.
    if (path.dirname(dataRoot) !== os.tmpdir() || !path.basename(dataRoot).startsWith('peregrine-native-branding-')) throw new Error('Unsafe audit profile cleanup path');
    await fs.rm(dataRoot, {recursive:true,force:true});
  }
}

if (require.main === module) collectLiveBrandingEvidence().then(report => console.log(JSON.stringify(report.locales.map(item => ({locale:item.locale,title:item.branded.windows.map(window => window.title),settingsTitle:item.settings.title,aboutTitle:item.about.title,aboutHeadings:item.about.headings,aboutImages:item.about.images})), null, 2))).catch(error => {console.error(error);process.exitCode=1;});
module.exports = { collectLiveBrandingEvidence, internalPage, SNAPSHOT, navigationSnapshot, isNavigationContextMessage };
