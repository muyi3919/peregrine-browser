'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const APP_USER_MODEL_ID = 'local.peregrine.browser';
const PRODUCT_NAME = '游隼浏览器';

// CommandLineToArgvW-compatible quoting. There is no command shell involved.
function quoteWindowsArgument(value) {
  const text = String(value);
  if (!text || /[\s"]/u.test(text)) return '"' + text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';
  return text;
}

function helperPath() {
  if (process.resourcesPath && __dirname.includes('.asar')) return path.join(process.resourcesPath, 'native-brand-window.ps1');
  return path.resolve(__dirname, '../scripts/native-brand-window.ps1');
}

async function configuration(options, mode) {
  if (process.platform !== 'win32') throw new Error('原生窗口品牌设置仅支持 Windows。');
  if (!Number.isInteger(options.pid) || options.pid <= 0 || options.pid > 0xffffffff) throw new Error('原生浏览器进程 ID 无效。');
  const result = { mode, processId: options.pid, appUserModelId: APP_USER_MODEL_ID, productName: PRODUCT_NAME };
  for (const key of ['iconPath', 'processPath', 'relaunchPath']) {
    if (options[key] !== undefined) {
      if (typeof options[key] !== 'string' || !path.isAbsolute(options[key]) || /[\0\r\n"]/u.test(options[key])) throw new Error('原生窗口品牌文件路径无效。');
      result[key] = path.resolve(options[key]);
      await fs.access(result[key]);
    }
  }
  if (mode === 'watch' && (!result.iconPath || !result.relaunchPath)) throw new Error('原生窗口品牌设置缺少图标或启动程序。');
  const relaunchArguments = options.relaunchArguments || [];
  if (!Array.isArray(relaunchArguments) || relaunchArguments.some(value => typeof value !== 'string' || /[\0\r\n]/u.test(value))) throw new Error('原生窗口重新启动参数无效。');
  if (result.relaunchPath) result.relaunchCommand = [result.relaunchPath, ...relaunchArguments].map(quoteWindowsArgument).join(' ');
  return result;
}

function powershellArguments(scriptPath, config) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ConfigBase64', Buffer.from(JSON.stringify(config), 'utf8').toString('base64')];
}

/** Own-PID watcher: native resources own titles; this sets Windows taskbar identity. */
async function startNativeWindowBranding(options) {
  const config = await configuration(options, 'watch');
  const scriptPath = options.scriptPath || helperPath();
  await fs.access(scriptPath);
  const child = spawn('powershell.exe', powershellArguments(scriptPath, config), { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', closed = false;
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-6000); });
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => { closed = true; resolve({ code, signal }); }); child.once('error', error => { closed = true; resolve({ error }); }); });
  const controller = {
    pid: child.pid,
    ready: null,
    exitPromise: exited,
    get isAlive() { return !closed; },
    async close() {
      if (!closed) child.kill();
      await exited;
    },
  };
  controller.ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('原生浏览器窗口品牌设置超时。')), options.timeoutMs || 20000);
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', receive); child.off('error', fail); child.off('exit', premature); };
    const fail = error => { cleanup(); reject(error); };
    const premature = code => fail(new Error('原生浏览器窗口品牌设置失败 (' + code + ')：' + stderr));
    const receive = value => {
      stdout += value;
      const lineEnd = stdout.indexOf('\n');
      if (lineEnd < 0) return;
      try {
        const result = JSON.parse(stdout.slice(0, lineEnd));
        if (result.event !== 'ready' || !Array.isArray(result.windows) || !result.windows.length) throw new Error('窗口品牌助手返回了无效结果。');
        cleanup(); resolve(result);
      } catch (error) { fail(error); }
    };
    child.stdout.on('data', receive); child.once('error', fail); child.once('exit', premature);
  }).catch(async error => { await controller.close(); throw error; });
  // Readiness is the only stdout event. Keep draining the streams until shutdown.
  child.stdout.resume();
  return controller;
}

/** Read-only native properties for integration checks; never changes another window. */
async function inspectNativeWindows(options) {
  const config = await configuration(options, 'inspect');
  const scriptPath = options.scriptPath || helperPath();
  await fs.access(scriptPath);
  const { stdout } = await run('powershell.exe', powershellArguments(scriptPath, config), { windowsHide: true, shell: false, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

module.exports = { APP_USER_MODEL_ID, PRODUCT_NAME, quoteWindowsArgument, startNativeWindowBranding, inspectNativeWindows };
