'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {parseDataPack,dataPackResource} = require('../scripts/brand-native-resources');
const {PRODUCT_NAME,APP_USER_MODEL_ID,quoteWindowsArgument,inspectNativeWindows} = require('../src/native-brand-window');
const {NativeHost} = require('../src/native-host');
const {collectLiveBrandingEvidence} = require('../verification/native-branding-probe.cjs');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname,'..');
const ORIGINAL = path.join(ROOT,'vendor/fingerprint-chromium/runtime/ungoogled-chromium_150.0.7871.186-1.1_windows_x64');
const BRANDED = path.join(ROOT,'vendor/peregrine-chromium/runtime');
const MANIFEST = path.join(BRANDED,'brand-manifest.json');
const OFFICIAL_EXE_SHA = '65d0807599b5430ffbd9dffb60cd020464815f10557352959e3aa4c125a5c439';
const CORE_VERSION = '150.0.7871.186';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const staged = fs.existsSync(MANIFEST);

// Parse PE headers independently of the resource patcher's PE library. Compare
// raw section bytes and executable header values, not only its own manifest.
function executableSections(filename) {
  const data = fs.readFileSync(filename);
  assert.equal(data.readUInt16LE(0),0x5a4d);
  const pe = data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(pe),0x4550);
  const count = data.readUInt16LE(pe+6), optionalSize = data.readUInt16LE(pe+20);
  const optional = pe+24;
  assert.equal(data.readUInt16LE(optional),0x20b,'Windows x64 PE32+');
  const instructions = {
    machine:data.readUInt16LE(pe+4),characteristics:data.readUInt16LE(pe+22),
    sizeOfCode:data.readUInt32LE(optional+4),entryPoint:data.readUInt32LE(optional+16),
    baseOfCode:data.readUInt32LE(optional+20),imageBase:data.readBigUInt64LE(optional+24).toString(),
    sectionAlignment:data.readUInt32LE(optional+32),fileAlignment:data.readUInt32LE(optional+36),
    subsystem:data.readUInt16LE(optional+68),dllCharacteristics:data.readUInt16LE(optional+70),
  };
  const sections=[];
  for(let i=0;i<count;i+=1){
    const offset=optional+optionalSize+i*40;
    const name=data.subarray(offset,offset+8).toString('ascii').replace(/\0.*$/u,'');
    const rawSize=data.readUInt32LE(offset+16),rawOffset=data.readUInt32LE(offset+20);
    sections.push({name,virtualSize:data.readUInt32LE(offset+8),virtualAddress:data.readUInt32LE(offset+12),rawSize,characteristics:data.readUInt32LE(offset+36),sha256:sha(data.subarray(rawOffset,rawOffset+rawSize))});
  }
  return {sha256:sha(data),instructions,sections};
}

async function fileSha(filename) {
  const digest=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(filename))digest.update(chunk);
  return digest.digest('hex');
}
function runtimeFiles(directory,relative='') {
  const files=[];
  for(const entry of fs.readdirSync(path.join(directory,relative),{withFileTypes:true})){
    const child=path.join(relative,entry.name);
    if(entry.isDirectory())files.push(...runtimeFiles(directory,child));
    else if(entry.isFile())files.push(child.replace(/\\/gu,'/'));
    else throw new Error('Unexpected upstream runtime link: '+child);
  }
  return files.sort();
}
async function versionInfo(filenames){
  const quoted=filenames.map(filename=>"'"+filename.replace(/'/gu,"''")+"'").join(',');
  const script=`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); @(${quoted}) | ForEach-Object { $v=(Get-Item -LiteralPath $_).VersionInfo; [pscustomobject]@{Path=$_;FileDescription=$v.FileDescription;ProductName=$v.ProductName;FileVersion=$v.FileVersion;ProductVersion=$v.ProductVersion;CompanyName=$v.CompanyName;LegalCopyright=$v.LegalCopyright} } | ConvertTo-Json -Depth 5 -Compress`;
  const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}

test('branded native distribution preserves the original runtime and executable code',{skip:!staged,timeout:120000},async()=>{
  const manifest=JSON.parse(await fsp.readFile(MANIFEST,'utf8'));
  const source=JSON.parse(await fsp.readFile(path.join(ROOT,'vendor/fingerprint-chromium/fingerprint-source.json'),'utf8'));
  assert.equal(manifest.productName,PRODUCT_NAME);
  assert.equal(manifest.engine,'Chromium');
  assert.equal(manifest.upstreamExecutableSha256,OFFICIAL_EXE_SHA);
  assert.equal(source.binarySha256,OFFICIAL_EXE_SHA);
  assert.equal(source.version,CORE_VERSION);
  assert.equal(source.project,'https://github.com/adryfish/fingerprint-chromium');
  assert.equal(source.officialDigest,'sha256:'+source.archiveSha256);
  assert.ok(source.sourceAvailability.includes('delayed'),'do not claim complete 150 patch availability');
  assert.ok(manifest.sourceReferences.includes('https://github.com/adryfish/fingerprint-chromium'));
  assert.ok(manifest.sourceReferences.includes('https://github.com/chromium/chromium'));
  const changes=new Map(manifest.files.map(file=>[file.path,file]));
  assert.equal(changes.size,manifest.files.length,'manifest paths are unique');
  const executableReports=[];
  for(const filename of ['chrome.exe','chrome.dll','chrome_proxy.exe','chrome_pwa_launcher.exe']){
    const original=executableSections(path.join(ORIGINAL,filename));
    const branded=executableSections(path.join(BRANDED,filename));
    const declared=changes.get(filename);
    assert.ok(declared,filename+' is recorded');
    assert.equal(original.sha256,declared.originalSha256);
    assert.equal(branded.sha256,declared.brandedSha256);
    if(filename==='chrome.exe')assert.equal(original.sha256,OFFICIAL_EXE_SHA);
    assert.deepEqual(branded.instructions,original.instructions,filename+' executable headers');
    assert.deepEqual(branded.sections.map(section=>section.name),original.sections.map(section=>section.name));
    const compared=[];
    for(const section of original.sections.filter(item=>item.name!=='.rsrc')){
      const counterpart=branded.sections.find(item=>item.name===section.name);
      assert.equal(counterpart.sha256,section.sha256,filename+':'+section.name+' bytes');
      assert.equal(counterpart.rawSize,section.rawSize,filename+':'+section.name+' size');
      assert.equal(counterpart.virtualSize,section.virtualSize,filename+':'+section.name+' virtual size');
      assert.equal(counterpart.characteristics,section.characteristics,filename+':'+section.name+' access flags');
      if(section.name!=='.reloc')assert.equal(counterpart.virtualAddress,section.virtualAddress,filename+':'+section.name+' address');
      compared.push({...section,brandedVirtualAddress:counterpart.virtualAddress,unchanged:true});
    }
    executableReports.push({filename,originalSha256:original.sha256,brandedSha256:branded.sha256,nonResourceSections:compared});
  }
  const originalFiles=runtimeFiles(ORIGINAL);
  assert.deepEqual(runtimeFiles(BRANDED).filter(filename=>filename!=='brand-manifest.json'),originalFiles,'no runtime component removed or injected');
  let unchangedFiles=0;
  for(const filename of originalFiles){
    const declared=changes.get(filename);
    if(declared){
      assert.match(filename,/^(?:chrome\.(?:exe|dll)|chrome_proxy\.exe|chrome_pwa_launcher\.exe|resources\.pak|chrome_(?:100|200)_percent\.pak|locales\/[^/]+\.pak)$/u,'only declared resource-bearing files may change');
      assert.equal(await fileSha(path.join(ORIGINAL,filename)),declared.originalSha256,filename+' original hash');
      assert.equal(await fileSha(path.join(BRANDED,filename)),declared.brandedSha256,filename+' branded hash');
    }else{
      assert.equal(await fileSha(path.join(BRANDED,filename)),await fileSha(path.join(ORIGINAL,filename)),filename+' unpatched bytes');
      unchangedFiles+=1;
    }
  }
  const licenses={};
  for(const filename of ['fingerprint-LICENSE.txt','chromium-LICENSE.txt','chromium-licenses.html'])licenses[filename]=await fileSha(path.join(ROOT,'vendor/fingerprint-chromium',filename));
  const versions=await versionInfo(['chrome.exe','chrome.dll'].flatMap(filename=>[path.join(ORIGINAL,filename),path.join(BRANDED,filename)]));
  for(let index=0;index<versions.length;index+=2){
    const original=versions[index],branded=versions[index+1];
    assert.equal(branded.ProductName,PRODUCT_NAME);assert.equal(branded.FileDescription,PRODUCT_NAME);
    for(const key of ['FileVersion','ProductVersion','CompanyName','LegalCopyright'])assert.equal(branded[key],original[key],key+' retained');
    assert.ok(branded.FileVersion.includes(CORE_VERSION));
  }
  await fsp.writeFile(path.join(ROOT,'verification/native-branding-integrity.json'),JSON.stringify({capturedAt:new Date().toISOString(),officialSource:source,brandingVersion:manifest.brandingVersion,upstreamExecutableSha256:OFFICIAL_EXE_SHA,runtimeFileCount:originalFiles.length,unchangedFiles,modifiedResourceFiles:manifest.files.map(file=>file.path),licenses,versions,executables:executableReports},null,2)+'\n');
});

test('English and Chinese native resource branding retains author copyright and upstream links',{skip:!staged},async()=>{
  for(const locale of ['en-US','zh-CN']){
    const original=parseDataPack(await fsp.readFile(path.join(ORIGINAL,'locales',locale+'.pak')));
    const branded=parseDataPack(await fsp.readFile(path.join(BRANDED,'locales',locale+'.pak')));
    const encoding=branded.encoding===2?'utf16le':'utf8';
    assert.equal(dataPackResource(branded,101).data.toString(encoding),PRODUCT_NAME);
    for(const id of [949,950])assert.deepEqual(dataPackResource(branded,id).data,dataPackResource(original,id).data,'author/copyright resource '+id);
    const attribution=dataPackResource(branded,34399).data.toString(encoding);
    assert.ok(attribution.includes(PRODUCT_NAME));
    const originalLinks=dataPackResource(original,34399).data.toString(encoding).match(/<a\b[^>]*>[\s\S]*?<\/a>/gu);
    assert.deepEqual(attribution.match(/<a\b[^>]*>[\s\S]*?<\/a>/gu),originalLinks.map(link=>link.replace('href="$1"','href="https://www.chromium.org/"')),'retain attribution labels/targets, correcting only upstream Chromium placeholder URL');
  }
});

test('real native windows and Settings/About use Peregrine branding in English and Chinese',{skip:process.platform!=='win32'||!staged,timeout:120000},async()=>{
  const report=await collectLiveBrandingEvidence();
  assert.deepEqual(report.locales.map(item=>item.locale),['en-US','zh-CN']);
  for(const item of report.locales){
    assert.equal(item.branded.processPath,path.join(BRANDED,'chrome.exe'));
    assert.ok(item.before.windows.length>0);
    for(const window of item.before.windows)assert.equal(window.title,'Native branding audit - '+PRODUCT_NAME,'PAK owns title before helper');
    for(const collection of [item.branded,item.aboutWindows]){
      assert.ok(collection.windows.length>0);
      for(const window of collection.windows){
        assert.ok(window.title.includes(PRODUCT_NAME));
        assert.equal(window.appUserModelId,APP_USER_MODEL_ID);
        assert.equal(window.relaunchDisplayName,PRODUCT_NAME);
        assert.equal(window.relaunchCommand,[path.join(ROOT,'node_modules/electron/dist/electron.exe'),ROOT].map(quoteWindowsArgument).join(' '));
        assert.equal(window.relaunchIconResource,path.join(ROOT,'ui/assets/peregrine.ico')+',0');
        assert.equal(window.smallIconHash,collection.expectedIconHashes.small);
        assert.equal(window.bigIconHash,collection.expectedIconHashes.big);
      }
    }
    assert.ok(item.settings.texts.some(text=>text.includes(PRODUCT_NAME)));
    assert.ok(item.about.title.includes(PRODUCT_NAME));
    assert.ok(item.about.headings.some(text=>text.includes(PRODUCT_NAME)));
    assert.ok(item.about.texts.some(text=>text.includes(CORE_VERSION)));
    assert.ok(item.about.texts.some(text=>text.includes('The Chromium Authors')));
    assert.ok(item.about.texts.some(text=>text.includes('Chromium')),'upstream project attribution remains explicit');
    assert.equal(item.about.language,item.locale==='zh-CN'?'zh':'en');
    assert.ok(item.about.images.some(image=>image.visible&&image.alt.includes(PRODUCT_NAME)));
    for(const variant of [item.about,item.darkAbout,item.about2x,item.narrowAbout]){
      for(const field of ['app-version','engine','manual-update','core-copyright'])assert.equal(variant.aboutFields[field]?.visible,true,`${item.locale} ${field} is visible`);
      assert.equal(variant.aboutFields['app-version'].text,PRODUCT_NAME+' '+APP_VERSION);
      assert.ok(variant.aboutFields.engine.text.includes('Chromium '+CORE_VERSION));
      assert.ok(variant.aboutFields.engine.text.includes('Blink'));
      assert.ok(variant.aboutFields['manual-update'].text.includes('automatic updates are not supported'));
      assert.ok(variant.aboutFields['core-copyright'].text.includes('Upstream core copyright'));
      assert.ok(variant.aboutFields['core-copyright'].text.includes('The Chromium Authors'));
    }
    assert.ok(item.about.links.some(link=>link.href==='https://github.com/adryfish/fingerprint-chromium'));
    assert.ok(item.about.links.some(link=>link.href==='https://www.chromium.org/'));
    assert.ok(item.about.links.some(link=>link.href==='chrome://credits/'));
    assert.ok(!item.about.links.some(link=>link.href.includes('qjz9zk')),'no unusable upstream placeholder link');
    assert.ok(item.about.texts.some(text=>text.includes('Windows')&&text.includes('64')));
    assert.ok(item.about.productGlyphs.length>0,'About sidebar product glyph is present');
    for(const glyph of item.about.productGlyphs){assert.ok(glyph.shadow.includes('data:image/png;base64,'),'sidebar glyph uses brand artwork');assert.ok(!glyph.shadow.includes('M336-479'),'old Chromium product vector is replaced');}
    assert.equal(item.narrowAbout.layout.scrollWidth,item.narrowAbout.layout.width,'520px viewport does not require horizontal scrolling');
    assert.ok(item.narrowAbout.aboutLayout.scrollWidth<=item.narrowAbout.aboutLayout.clientWidth,'About article has no hidden horizontal overflow');
    assert.ok(item.narrowAbout.aboutLayout.left>=0&&item.narrowAbout.aboutLayout.right<=item.narrowAbout.layout.width,'About article fits inside the actual narrow viewport');
    const scrollContainer=item.narrowAbout.aboutLayout.ancestors.find(ancestor=>ancestor.id==='container');
    assert.ok(scrollContainer.scrollWidth<=scrollContainer.clientWidth,'actual Settings scroll container has no horizontal overflow');
    assert.ok(item.scrollProof?.scrollTop>0,'native Settings vertical scrolling remains usable');
    assert.ok(item.narrowFooter.aboutFields['core-copyright'].top>=0&&item.narrowFooter.aboutFields['core-copyright'].bottom<=780,'upstream copyright can be read in the narrow viewport');
    assert.deepEqual(item.pageErrors,[],'Settings/About have no runtime exception or error console entries');
    assert.ok(item.themeLogos.length>0,'native theme logo response was observed');
    assert.deepEqual(item.themeLogos.map(logo=>logo.actual.width).sort((a,b)=>a-b),[24,32,64],'dark SVG, light 1x, and light 2x native artwork is exercised');
    for(const logo of item.themeLogos)assert.equal(logo.match,true,`${item.locale} ${logo.url} renders exact Peregrine ICO pixels`);
  }
});

test('NativeHost closes its own helper on shutdown but keeps browsing after cosmetic helper failure',{skip:process.platform!=='win32'||!staged,timeout:120000},async()=>{
  const dataRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'peregrine-native-branding-lifecycle-'));
  const hosts=[],evidence=[];
  try{
    for(const mode of ['normal-close','helper-exit']){
      const host=new NativeHost({dataRoot,binaryPath:path.join(BRANDED,'chrome.exe'),windowBranding:{iconPath:path.join(ROOT,'ui/assets/peregrine.ico'),relaunchPath:path.join(ROOT,'node_modules/electron/dist/electron.exe'),relaunchArguments:[ROOT]},profile:{id:mode,fingerprintSeed:123456789,canvasMode:'compatibility',locale:'en-US',timezone:'UTC',homepage:'about:blank',locationMode:'block',security:{httpsOnly:false,webrtc:'block',camera:'block',microphone:'block',notifications:'block'}}});
      hosts.push(host);
      await host.initialize();
      assert.equal(host.isAlive,true);
      assert.equal(host.brandController.isAlive,true);
      const windows=await inspectNativeWindows({pid:host.child.pid,processPath:path.join(BRANDED,'chrome.exe'),iconPath:path.join(ROOT,'ui/assets/peregrine.ico')});
      assert.ok(windows.windows.length>0);
      for(const window of windows.windows){
        assert.equal(window.appUserModelId,APP_USER_MODEL_ID);
        assert.equal(window.relaunchDisplayName,PRODUCT_NAME);
        assert.equal(window.smallIconHash,windows.expectedIconHashes.small);
        assert.equal(window.bigIconHash,windows.expectedIconHashes.big);
      }
      if(mode==='helper-exit'){
        // This is the helper created by this test's exact, new host.
        await host.brandController.close();
        await new Promise(resolve=>setTimeout(resolve,1200));
        assert.equal(host.isAlive,true,'cosmetic helper failure must not close a working browser');
        assert.match(host.brandWarning.message,/品牌助手/u);
        assert.equal(host.lastError,undefined);
        assert.equal(await host.evaluate('6*7'),42,'browser control remains usable after the helper exits');
      }else{
        // Suspend only this test's newly spawned browser to exercise a real
        // SendMessageTimeout, then detach/resume it even if the probe fails.
        const debugScript=`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BusyBrowserProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DebugActiveProcess(uint pid); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DebugActiveProcessStop(uint pid); [DllImport("kernel32.dll")] public static extern bool DebugSetProcessKillOnExit(bool kill); }'; if(![BusyBrowserProbe]::DebugActiveProcess(${host.child.pid})){throw 'Cannot suspend owned test browser'}; try { [BusyBrowserProbe]::DebugSetProcessKillOnExit($false) | Out-Null; Start-Sleep -Milliseconds 3200 } finally { [BusyBrowserProbe]::DebugActiveProcessStop(${host.child.pid}) | Out-Null }`;
        await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(debugScript,'utf16le').toString('base64')],{windowsHide:true,timeout:15000});
        assert.equal(host.isAlive,true,'a temporarily unresponsive window must not close the browser');
        assert.equal(host.brandController.isAlive,true,'taskbar helper retries after actual window-message timeouts');
        assert.equal(await host.evaluate('6*7'),42,'browsing resumes after the busy window recovers');
      }
      await host.close();
      assert.equal(host.isAlive,false);
      assert.equal(host.brandController.isAlive,false);
      evidence.push({mode,processId:host.child.pid,helperPid:host.brandController.pid,windows,browserClosed:!host.isAlive,helperClosed:!host.brandController.isAlive,lastError:host.lastError?.message});
    }
    await fsp.writeFile(path.join(ROOT,'verification/native-branding-lifecycle.json'),JSON.stringify({capturedAt:new Date().toISOString(),scope:'Only exact, newly launched temporary test browser and helper PIDs.',cases:evidence},null,2)+'\n');
  }finally{
    for(const host of hosts)await host.close();
    if(path.dirname(dataRoot)!==os.tmpdir()||!path.basename(dataRoot).startsWith('peregrine-native-branding-lifecycle-'))throw new Error('Unsafe branding test cleanup');
    await fsp.rm(dataRoot,{recursive:true,force:true});
  }
});

test('a missing optional taskbar helper does not prevent browsing or normal shutdown',{skip:process.platform!=='win32'||!staged,timeout:30000},async()=>{
  const dataRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'peregrine-native-branding-missing-'));
  const diagnostics=[];
  const host=new NativeHost({dataRoot,binaryPath:path.join(BRANDED,'chrome.exe'),onDiagnostic:record=>diagnostics.push(record),windowBranding:{iconPath:path.join(ROOT,'ui/assets/peregrine.ico'),relaunchPath:path.join(ROOT,'node_modules/electron/dist/electron.exe'),scriptPath:path.join(dataRoot,'missing-helper.ps1')},profile:{id:'missing-helper',fingerprintSeed:123456789,canvasMode:'stable',locale:'en-US',timezone:'UTC',homepage:'about:blank',locationMode:'block',security:{httpsOnly:false,webrtc:'block',camera:'block',microphone:'block',notifications:'block'}}});
  try {
    await host.initialize();assert.equal(host.isAlive,true);assert.equal(host.brandController,null);
    assert.ok(diagnostics.some(record=>record.event==='window-branding-start-failed'));
    assert.equal(await host.evaluate('6*7'),42);
    await host.close();assert.equal(host.isAlive,false);
  }finally{
    await host.close();assert.equal(path.dirname(dataRoot),os.tmpdir());assert.ok(path.basename(dataRoot).startsWith('peregrine-native-branding-missing-'));await fsp.rm(dataRoot,{recursive:true,force:true});
  }
});
