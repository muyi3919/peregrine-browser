'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteWindowsArgument, startNativeWindowBranding, APP_USER_MODEL_ID, PRODUCT_NAME } = require('../src/native-brand-window');

test('Windows relaunch quoting preserves spaces, quotes and trailing backslashes without a shell', () => {
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('E:\\游隼 浏览器\\PeregrineBrowser.exe'), '"E:\\游隼 浏览器\\PeregrineBrowser.exe"');
  assert.equal(quoteWindowsArgument('path with space\\'), '"path with space\\\\"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
});

test('taskbar identity is stable across versions and only valid positive PIDs are eligible', async () => {
  assert.equal(APP_USER_MODEL_ID, 'local.peregrine.browser');
  assert.equal(PRODUCT_NAME, '游隼浏览器');
  if (process.platform === 'win32') for (const pid of [0, -1, 1.1, NaN, Infinity, 0x100000000]) await assert.rejects(startNativeWindowBranding({ pid }), /进程 ID/u);
});
