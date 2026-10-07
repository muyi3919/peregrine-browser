'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { buildFingerprintPixelsSource, PIXEL_ALGORITHM } = require('../src/fingerprint-pixels');
const { NativeHost } = require('../src/native-host');
const binaryPath = path.resolve(__dirname, '../vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64/chrome.exe');
const seedA = 123456789, seedB = 987654321;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fnv(bytes) { let hash = 2166136261; for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash; }
function decodePNG(encoded) {
  const bytes = Buffer.from(encoded.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = []; let width, height;
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    const content = bytes.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') { width = content.readUInt32BE(0); height = content.readUInt32BE(4); assert.equal(content[8], 8); assert.equal(content[9], 6); }
    if (type === 'IDAT') idat.push(content);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte;
      for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + size), `${type} CRC`);
    offset += size + 12;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  assert.equal(inflated.length, (width * 4 + 1) * height);
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const at = row * (width * 4 + 1); assert.equal(inflated[at], 0, 'deterministic PNG uses filter zero');
    inflated.copy(pixels, row * width * 4, at + 1, at + 1 + width * 4);
  }
  return { width, height, pixels, bytes };
}

test('pixel injection validates seeds, is self-contained and idempotent per realm', () => {
  for (const invalid of [-1, 0x100000000, 1.5, NaN, '1', 1n]) assert.throws(() => buildFingerprintPixelsSource(invalid), /uint32/);
  const realm = vm.createContext({});
  const status = vm.runInContext(buildFingerprintPixelsSource(0), realm);
  assert.equal(status.algorithm, PIXEL_ALGORITHM); assert.equal(status.seed, 0); assert.equal(status.stableReadback, true);
  assert.equal(vm.runInContext(buildFingerprintPixelsSource(0), realm), status);
  assert.throws(() => vm.runInContext(buildFingerprintPixelsSource(1), realm), /already installed/);
  const disabled = vm.runInNewContext(buildFingerprintPixelsSource(0xffffffff, { stableReadback: false }));
  assert.equal(disabled.seed, 0xffffffff); assert.equal(disabled.stableReadback, false);
});

const draw = `function draw(x) {
  x.fillStyle='#f60';x.fillRect(17,4,125,46);x.font='18px Arial';x.fillStyle='#069';x.fillText('Peregrine Canvas 123456789',5,27);
  x.globalCompositeOperation='multiply';x.fillStyle='rgba(100,200,50,.7)';x.beginPath();x.arc(90,38,25,0,Math.PI*2);x.fill();
  x.globalCompositeOperation='source-over';const g=x.createLinearGradient(0,0,300,80);g.addColorStop(0,'rgba(150,40,250,.23)');g.addColorStop(1,'rgba(10,210,50,.81)');x.fillStyle=g;x.fillRect(155,3,100,70);
  x.save();x.translate(197,41);x.rotate(.237);x.fillStyle='rgba(30,60,180,.47)';x.fillRect(-17,-11,34,22);x.restore();
}`;
const helpers = `
  const hash=a=>{let n=2166136261;for(const b of a)n=Math.imul(n^b,16777619)>>>0;return n};
  const base64=a=>{let s='';for(let i=0;i<a.length;i+=8192)s+=String.fromCharCode(...a.subarray(i,i+8192));return btoa(s)};
  ${draw}
`;
const canvasProbe = `(async()=>{
  await document.fonts.ready;
  ${helpers}
  const c=document.createElement('canvas');c.width=300;c.height=80;const x=c.getContext('2d');draw(x);
  const originalBefore=hash(window.pixelTestNativeGet.call(x,0,0,300,80).data);
  const raw=x.getImageData(0,0,300,80);const rawHash=hash(raw.data);
  const url=c.toDataURL();const repeat=c.toDataURL();
  const blob=await new Promise(resolve=>c.toBlob(resolve));const blob64=base64(new Uint8Array(await blob.arrayBuffer()));
  const originalAfter=hash(window.pixelTestNativeGet.call(x,0,0,300,80).data);
  const crop=x.getImageData(5,7,7,4),negative=x.getImageData(12,11,-7,-4);
  let cropOK=true;for(let r=0;r<4;r++)for(let k=0;k<7;k++)for(let channel=0;channel<4;channel++)if(crop.data[(r*7+k)*4+channel]!==raw.data[((r+7)*300+k+5)*4+channel])cropOK=false;
  let coercions=0;const coordinate={valueOf(){coercions++;return 5.9}};x.getImageData(coordinate,7,7,4);
  let receiverCoercions=0;try{x.getImageData.call({}, {valueOf(){receiverCoercions++;return 0}},0,1,1)}catch{}
  const errors=[];for(const args of [[0,0,0,1],[Infinity,0,1,1],[2147483648,0,1,1],[1n,0,1,1]]){try{x.getImageData(...args);errors.push('allowed')}catch(e){errors.push(e.name)}}
  let optsReads={};const opts={};for(const [key,value]of Object.entries({alpha:false,colorSpace:'srgb',desynchronized:false,willReadFrequently:false})){Object.defineProperty(opts,key,{get(){optsReads[key]=(optsReads[key]||0)+1;return value}})}
  const optionCanvas=document.createElement('canvas');const optionContext=optionCanvas.getContext({toString(){return '2d'},valueOf(){throw Error('incorrect default hint')}},opts);
  const frozen=document.createElement('canvas').getContext('2d',Object.freeze({willReadFrequently:false,alpha:false}));
  const invalidType=[];for(const method of ['toDataURL','getContext']){try{c[method](Symbol());invalidType.push('allowed')}catch(e){invalidType.push(e.name)}}
  const off=new OffscreenCanvas(300,80);const ox=off.getContext('2d');draw(ox);const offRaw=hash(ox.getImageData(0,0,300,80).data);const offBlob=await off.convertToBlob();const off64=base64(new Uint8Array(await offBlob.arrayBuffer()));
  const wide=document.createElement('canvas');wide.width=7;wide.height=3;const wx=wide.getContext('2d',{colorSpace:'display-p3'});wx.fillStyle='color(display-p3 1 .2 .1)';wx.fillRect(0,0,7,3);const wideNative=window.pixelTestNativeGet.call(wx,0,0,7,3,{colorSpace:'display-p3'});const wideRaw=wx.getImageData(0,0,7,3,{colorSpace:'display-p3'});const wideOK=hash(wideRaw.data)===hash(wideNative.data)&&wide.toDataURL()===window.pixelTestNativeURL.call(wide);
  const hdr=document.createElement('canvas');hdr.width=7;hdr.height=3;const hx=hdr.getContext('2d',{colorSpace:'srgb',colorType:'float16'});hx.fillStyle='rgba(50,200,30,.45)';hx.fillRect(0,0,7,3);const hdrAttributes=hx.getContextAttributes();const hdrOK=hdrAttributes.colorType!=='float16'||hdr.toDataURL()===window.pixelTestNativeURL.call(hdr);
  const z=document.createElement('canvas');z.width=0;const zeroURL=z.toDataURL();const zeroBlob=await new Promise(resolve=>z.toBlob(resolve));
  let offZero;try{await new OffscreenCanvas(0,1).convertToBlob();offZero='allowed'}catch(e){offZero=e.name}
  let callbackError=false;try{c.toBlob(null)}catch(e){callbackError=e instanceof TypeError}
  let offReceiverReads=0;try{await off.convertToBlob.call({}, {get quality(){offReceiverReads++;return .5}})}catch{}
  const resizing=document.createElement('canvas');resizing.getContext('2d');let typeConversions=0;const resizedURL=resizing.toDataURL({toString(){typeConversions++;resizing.width=3;resizing.height=2;return 'image/png'},valueOf(){throw Error('incorrect default hint')}});
  let callbackReported=false;const reported=new Promise(resolve=>{const listener=e=>{if(e.message.includes('pixel callback sentinel')){e.preventDefault();removeEventListener('error',listener);callbackReported=true;resolve(true)}};addEventListener('error',listener);c.toBlob(()=>{throw Error('pixel callback sentinel')});});await reported;
  return {rawHash,url,repeat,blob64,originalBefore,originalAfter,cropOK,negativeOK:hash(crop.data)===hash(negative.data),coercions,receiverCoercions,errors,optsReads,attributes:optionContext.getContextAttributes(),frozen:frozen.getContextAttributes().willReadFrequently,invalidType,offRaw,off64,wideOK,hdrOK,hdrAttributes,zeroURL,zeroBlob:zeroBlob===null,offZero,callbackError,offReceiverReads,typeConversions,resizedURL,callbackReported};
})()`;
const webglProbe = `(()=>{
  ${helpers}
  const results=[];
  for(const name of ['webgl','webgl2']){
    const c=document.createElement('canvas');c.width=8;c.height=5;const gl=c.getContext(name,{preserveDrawingBuffer:true,antialias:false});if(!gl){results.push({name,supported:false});continue}
    gl.clearColor(.321,.456,.789,1);gl.clear(gl.COLOR_BUFFER_BIT);
    const raw=new Uint8Array(8*5*4);gl.readPixels(0,0,8,5,gl.RGBA,gl.UNSIGNED_BYTE,raw);
    const repeat=new Uint8Array(raw.length);gl.readPixels(0,0,8,5,gl.RGBA,gl.UNSIGNED_BYTE,repeat);
    const clamped=new Uint8ClampedArray(raw.length);gl.readPixels(0,0,8,5,gl.RGBA,gl.UNSIGNED_BYTE,clamped);
    const crop=new Uint8Array(2*2*4);gl.readPixels(2,1,2,2,gl.RGBA,gl.UNSIGNED_BYTE,crop);
    let cropOK=true;for(let y=0;y<2;y++)for(let x=0;x<2;x++)for(let ch=0;ch<4;ch++)if(crop[(y*2+x)*4+ch]!==raw[((y+1)*8+x+2)*4+ch])cropOK=false;
    const invalid=new Uint8Array(20).fill(77);gl.readPixels(0,0,1,1,gl.RGBA,gl.FLOAT,invalid);const error=gl.getError();
    const small=new Uint8Array(2).fill(71);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,small);const smallError=gl.getError();
    const item={name,supported:true,raw:[...raw],repeatOK:hash(raw)===hash(repeat),clampedOK:hash(raw)===hash(clamped),cropOK,invalidOK:invalid.every(v=>v===77),error,smallOK:small.every(v=>v===71),smallError,url:c.toDataURL()};
    if(name==='webgl2'){
      const offset=new Uint8Array(raw.length+12).fill(81);gl.readPixels(0,0,8,5,gl.RGBA,gl.UNSIGNED_BYTE,offset,8);item.offsetOK=offset.slice(0,8).every(v=>v===81)&&hash(offset.subarray(8,8+raw.length))===hash(raw)&&offset.slice(8+raw.length).every(v=>v===81);
      gl.pixelStorei(gl.PACK_ROW_LENGTH,5);gl.pixelStorei(gl.PACK_SKIP_ROWS,1);gl.pixelStorei(gl.PACK_SKIP_PIXELS,1);gl.pixelStorei(gl.PACK_ALIGNMENT,8);
      const packed=new Uint8Array(100).fill(89);gl.readPixels(2,1,2,2,gl.RGBA,gl.UNSIGNED_BYTE,packed,3);
      const touched=new Set();let packedOK=true;for(let row=0;row<2;row++)for(let k=0;k<8;k++){const at=3+24+4+row*24+k;touched.add(at);if(packed[at]!==crop[row*8+k])packedOK=false}
      item.packedOK=packedOK&&packed.every((v,k)=>touched.has(k)||v===89);
      gl.pixelStorei(gl.PACK_ROW_LENGTH,0);gl.pixelStorei(gl.PACK_SKIP_ROWS,0);gl.pixelStorei(gl.PACK_ALIGNMENT,4);const invalidPack=new Uint8Array(32).fill(91);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,invalidPack);item.invalidPackOK=invalidPack.every(v=>v===91);item.invalidPackError=gl.getError();gl.pixelStorei(gl.PACK_SKIP_PIXELS,0);
      gl.readBuffer(gl.NONE);const none=new Uint8Array(16).fill(93);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,none);item.noneOK=none.every(v=>v===93);item.noneError=gl.getError();gl.readBuffer(gl.BACK);
      const pbo=gl.createBuffer();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,pbo);gl.bufferData(gl.PIXEL_PACK_BUFFER,160,gl.STREAM_READ);gl.readPixels(0,0,8,5,gl.RGBA,gl.UNSIGNED_BYTE,0);item.pboError=gl.getError();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);gl.deleteBuffer(pbo);
    }else{
      const extra=new Uint8Array(8).fill(95);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,extra,{valueOf(){throw Error('ignored argument converted')}});item.extraOK=hash(extra.subarray(0,4))===hash(raw.subarray(0,4))&&extra.slice(4).every(v=>v===95);
    }
    results.push(item);
  }return results;
})()`;

test('real native pixels stay stable across seeds/restarts and preserve Canvas/WebGL behavior', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  await fs.access(binaryPath);
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'peregrine-pixels-test-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/cross-image') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWQAAAABJRU5ErkJggg==', 'base64')); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html><body>pixel fixture</body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, url = `http://localhost:${port}/`;
  const hosts = [];
  const open = async (seed, id) => {
    const profile = { id, fingerprintSeed: seed, canvasMode: 'compatibility', hardwareConcurrency: 4, locale: 'en-US', timezone: 'UTC', locationMode: 'block', homepage: 'about:blank', security: { webrtc: 'proxy', httpsOnly: false, camera: 'block', microphone: 'block', notifications: 'block' } };
    const host = new NativeHost({ profile, binaryPath, dataRoot }); hosts.push(host); await host.initialize();
    const session = await host.session();
    await host.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.pixelTestNativeGet=CanvasRenderingContext2D.prototype.getImageData;window.pixelTestNativeURL=HTMLCanvasElement.prototype.toDataURL;' }, session);
    await host.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildFingerprintPixelsSource(seed) }, session);
    await host.navigate(url);
    for (let i = 0; i < 100; i++) { if (await host.evaluate('document.readyState') === 'complete') return host; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Pixel fixture did not load');
  };
  try {
    const a = await open(seedA, 'pixels-a'); const first = await a.evaluate(canvasProbe);
    assert.equal(first.repeat, first.url); assert.equal(first.blob64, first.url.split(',')[1]);
    const decoded = decodePNG(first.url); assert.equal(decoded.width, 300); assert.equal(decoded.height, 80); assert.equal(fnv(decoded.pixels), first.rawHash);
    assert.equal(fnv(decodePNG(first.off64).pixels), first.offRaw); assert.equal(first.off64, first.blob64);
    assert.equal(first.originalBefore, first.originalAfter, 'readbacks/export never modify source bitmap');
    for (const key of ['cropOK', 'negativeOK', 'frozen', 'zeroBlob', 'callbackError', 'wideOK', 'hdrOK', 'callbackReported']) assert.equal(first[key], true, key);
    assert.equal(first.coercions, 1); assert.equal(first.receiverCoercions, 0); assert.equal(first.offReceiverReads, 0);
    assert.equal(first.typeConversions, 1); assert.equal(decodePNG(first.resizedURL).width, 3); assert.equal(decodePNG(first.resizedURL).height, 2);
    assert.deepEqual(first.errors, ['IndexSizeError', 'TypeError', 'TypeError', 'TypeError']);
    assert.deepEqual(first.optsReads, { alpha: 1, colorSpace: 1, desynchronized: 1, willReadFrequently: 1 });
    assert.equal(first.attributes.willReadFrequently, true); assert.equal(first.attributes.alpha, false); assert.equal(first.attributes.colorSpace, 'srgb');
    assert.deepEqual(first.invalidType, ['TypeError', 'TypeError']); assert.equal(first.zeroURL, 'data:,'); assert.equal(first.offZero, 'IndexSizeError');
    const webgl = await a.evaluate(webglProbe);
    for (const gl of webgl) {
      assert.equal(gl.supported, true, `${gl.name} available in fixture`);
      for (const key of ['repeatOK', 'clampedOK', 'cropOK', 'invalidOK', 'smallOK']) assert.equal(gl[key], true, `${gl.name} ${key}`);
      assert.notEqual(gl.error, 0); assert.notEqual(gl.smallError, 0);
      const rgba = decodePNG(gl.url).pixels;
      for (let row = 0; row < 5; row++) assert.deepEqual([...rgba.subarray(row * 32, (row + 1) * 32)], gl.raw.slice((4 - row) * 32, (5 - row) * 32), `${gl.name} Canvas export and GL readPixels agree after Y flip`);
      if (gl.name === 'webgl2') {
        for (const key of ['offsetOK', 'packedOK', 'invalidPackOK', 'noneOK']) assert.equal(gl[key], true, key);
        assert.notEqual(gl.invalidPackError, 0); assert.notEqual(gl.noneError, 0); assert.equal(gl.pboError, 0);
      } else assert.equal(gl.extraOK, true);
    }
    const taint = await a.evaluate(`(async()=>{const c=document.createElement('canvas'),x=c.getContext('2d'),image=new Image();image.src='http://127.0.0.1:${port}/cross-image';await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('image failed'))});x.drawImage(image,0,0);const names=[];for(const call of [()=>x.getImageData(0,0,1,1),()=>c.toDataURL(),()=>c.toBlob(()=>{})]){try{call();names.push('allowed')}catch(e){names.push(e.name)}}const off=new OffscreenCanvas(1,1);off.getContext('2d').drawImage(image,0,0);try{await off.convertToBlob();names.push('allowed')}catch(e){names.push(e.name)}return names})()`);
    assert.deepEqual(taint, ['SecurityError', 'SecurityError', 'SecurityError', 'SecurityError']);
    const workerBody = `${buildFingerprintPixelsSource(seedA)}\n(async()=>{${helpers}const c=new OffscreenCanvas(300,80),x=c.getContext('2d');draw(x);const raw=hash(x.getImageData(0,0,300,80).data);const blob=await c.convertToBlob();postMessage({raw,png:base64(new Uint8Array(await blob.arrayBuffer()))})})().catch(e=>postMessage({error:e.message}));`;
    const worker = await a.evaluate(`new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([${JSON.stringify(workerBody)}],{type:'application/javascript'}));const w=new Worker(url);const timer=setTimeout(()=>{w.terminate();URL.revokeObjectURL(url);reject(Error('worker timeout'))},8000);w.onmessage=e=>{clearTimeout(timer);w.terminate();URL.revokeObjectURL(url);resolve(e.data)};w.onerror=e=>{clearTimeout(timer);w.terminate();URL.revokeObjectURL(url);reject(Error('worker error'))}})`);
    assert.equal(worker.error, undefined); assert.equal(worker.raw, first.rawHash); assert.equal(worker.png, first.blob64);
    await a.close();
    const restarted = await open(seedA, 'pixels-a'); const again = await restarted.evaluate(canvasProbe); assert.equal(again.rawHash, first.rawHash); assert.equal(again.url, first.url); await restarted.close();
    const fresh = await open(seedA, 'pixels-a-fresh'); const equal = await fresh.evaluate(canvasProbe); assert.equal(equal.url, first.url); await fresh.close();
    const b = await open(seedB, 'pixels-b'); const different = await b.evaluate(canvasProbe); assert.notEqual(different.url, first.url); assert.notEqual(different.rawHash, first.rawHash); await b.close();
    console.log('Stable pixel proof', JSON.stringify({ algorithm: PIXEL_ALGORITHM, raw: first.rawHash, seedA: digest(decoded.bytes), seedB: digest(decodePNG(different.url).bytes), restartEqual: true, freshProfileEqual: true, workerEqual: true }));
  } finally {
    for (const host of hosts) await host.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
