'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const VERSION = '150.0.7871.186';
const NAME = `ungoogled-chromium_${VERSION}-1.1_windows_x64.zip`;
const DIGEST = '4d549c326e51ebbabf562fd365eb5380d9d4a81200da2c60f075c688d9a77e03';
const ROOT = path.resolve(__dirname, '../vendor/fingerprint-chromium');
const PROJECT = 'https://github.com/adryfish/fingerprint-chromium';
async function systemProxy() {
  try {
    const command = "$p=([System.Net.WebRequest]::GetSystemWebProxy()).GetProxy([uri]'https://github.com'); if($p.Host -in @('localhost','127.0.0.1','::1') -and -not $p.UserInfo){$p.AbsoluteUri}";
    const { stdout } = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', command], { windowsHide:true, timeout:5000 });
    const url = new URL(stdout.trim());
    return ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
async function download(url, output, proxy, accept = '*/*', resume = false) {
  await run('curl.exe', ['--silent','--show-error','--fail','--location','--connect-timeout','20','--max-time','2400','--retry','3',
    '--header','User-Agent: PeregrineBrowser-build','--header',`Accept: ${accept}`,
    ...(proxy ? ['--proxy',proxy] : []), ...(resume ? ['--continue-at','-'] : []),'--output',output,url],
  { windowsHide:true,timeout:10000000,maxBuffer:65536 });
}
async function main() {
  if (process.platform !== 'win32') throw new Error('This pinned runtime is Windows x64 only.');
  await fs.mkdir(ROOT, { recursive:true });
  const proxy = await systemProxy();
  const metadataPath = path.join(ROOT,'release.download.json');
  await download(`https://api.github.com/repos/adryfish/fingerprint-chromium/releases/tags/${VERSION}`, metadataPath, proxy);
  const release = JSON.parse(await fs.readFile(metadataPath,'utf8'));
  const asset = release.assets.find(item => item.name === NAME);
  if (release.tag_name !== VERSION || !asset || asset.digest !== `sha256:${DIGEST}`) throw new Error('Pinned official fingerprint Chromium release digest mismatch.');
  const archive = path.join(ROOT,'fingerprint.download.zip');
  console.log(`Downloading official fingerprint Chromium ${VERSION} (${asset.size} bytes).`);
  let archiveComplete=false;
  try {archiveComplete=(await fs.stat(archive)).size===asset.size;} catch {}
  if(!archiveComplete) await download(asset.browser_download_url, archive, proxy, '*/*', true);
  const buffer = await fs.readFile(archive);
  if (buffer.length !== asset.size || crypto.createHash('sha256').update(buffer).digest('hex') !== DIGEST) throw new Error('Official Chromium ZIP SHA-256 verification failed.');
  // Extraction is confined to the fixed vendor subtree after official hash verification.
  const command = "param($archive,$target); $ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath $archive -DestinationPath $target -Force";
  const expandScript = path.join(ROOT,'expand.download.ps1');
  await fs.writeFile(expandScript, command);
  let alreadyInstalled=false;
  try {
    const metadata=JSON.parse(await fs.readFile(path.join(ROOT,'fingerprint-source.json'),'utf8'));
    const existing=path.join(ROOT,metadata.binaryPath);
    alreadyInstalled=metadata.archiveSha256===DIGEST && metadata.version===VERSION && crypto.createHash('sha256').update(await fs.readFile(existing)).digest('hex')===metadata.binarySha256;
  } catch {}
  if(!alreadyInstalled) await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',expandScript,'-archive',archive,'-target',path.join(ROOT,'runtime')], { windowsHide:true,timeout:300000,maxBuffer:65536 });
  const candidates = [];
  async function find(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
      const full = path.join(directory,entry.name);
      if (entry.isDirectory()) await find(full);
      else if (entry.name === 'chrome.exe') candidates.push(full);
    }
  }
  await find(path.join(ROOT,'runtime'));
  if (candidates.length !== 1) throw new Error('Expected exactly one official chrome.exe.');
  const license = path.join(ROOT,'fingerprint-LICENSE.txt');
  await download('https://raw.githubusercontent.com/adryfish/fingerprint-chromium/main/LICENSE',license,proxy);
  const licenseText = await fs.readFile(license,'utf8');
  if (!licenseText.includes('Redistribution and use') || !licenseText.includes('Neither the name')) throw new Error('Complete upstream BSD-3 license was not retrieved.');
  const chromiumLicenseUrl=`https://raw.githubusercontent.com/chromium/chromium/${VERSION}/LICENSE`;
  await download(chromiumLicenseUrl,path.join(ROOT,'chromium-LICENSE.txt'),proxy);
  const {NativeHost}=require('../src/native-host');
  const licenseHost=new NativeHost({profile:{id:'license-export',fingerprintSeed:0,hardwareConcurrency:4,locale:'en-US',timezone:'UTC',homepage:'about:blank',security:{webrtc:'proxy',httpsOnly:false,camera:'block',microphone:'block',notifications:'block'}},binaryPath:candidates[0],dataRoot:path.join(ROOT,'license-export.download')});
  try {
    await licenseHost.initialize();
    await licenseHost.cdp.send('Page.navigate',{url:'chrome://credits/'},await licenseHost.session());
    for(let i=0;i<100;i++) {if(await licenseHost.evaluate('document.readyState')==='complete')break;await new Promise(resolve=>setTimeout(resolve,50));}
    await fs.writeFile(path.join(ROOT,'chromium-licenses.html'),await licenseHost.evaluate('document.documentElement.outerHTML'));
  } finally {await licenseHost.close();}
  await fs.writeFile(path.join(ROOT,'fingerprint-source.json'),JSON.stringify({
    project:PROJECT,version:VERSION,assetUrl:asset.browser_download_url,archiveSha256:DIGEST,officialDigest:asset.digest,
    binaryPath:path.relative(ROOT,candidates[0]).split(path.sep).join('/'),
    binarySha256:crypto.createHash('sha256').update(await fs.readFile(candidates[0])).digest('hex'),
    license:'BSD-3-Clause',licenseFile:'fingerprint-LICENSE.txt',
    sourceUrl:`${PROJECT}/tree/${VERSION}`,
    sourceAvailability:'The upstream README states Chromium 150 patches are delayed until Chromium 151; this link is not a claim that complete version 150 patches are available.',
    releasePatchSourceStatus:'upstream delayed until next major',
    chromiumLicenseFile:'chromium-LICENSE.txt',chromiumLicenseUrl,
    thirdPartyLicensesFile:'chromium-licenses.html',thirdPartyLicensesOrigin:'chrome://credits',
    retrievedAt:new Date().toISOString(),
  },null,2)+'\n');
  console.log('Official native fingerprint Chromium installed; GitHub digest verified.');
}
if(require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports={main,VERSION,DIGEST};
