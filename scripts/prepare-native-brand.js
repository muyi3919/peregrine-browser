'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stageBrandedRuntime,SOURCE_RUNTIME}=require('./brand-native-resources');
const original=crypto.createHash('sha256').update(fs.readFileSync(path.join(SOURCE_RUNTIME,'chrome.exe'))).digest('hex');
if(original!=='65d0807599b5430ffbd9dffb60cd020464815f10557352959e3aa4c125a5c439') throw new Error('上游原始内核校验失败；请重新下载固定版本内核。');
const manifest=stageBrandedRuntime();
console.log(`Prepared ${manifest.productName} native runtime (${manifest.files.length} resource files).`);
