'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createDiagnostics}=require('../src/diagnostics');
test('lifecycle diagnostics omit secrets and redact URL credentials and queries',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'peregrine-diagnostics-'));
  try {
    const log=createDiagnostics(directory,'test');
    log({event:'native-target-setup-failed',message:'Error at https://user:password@example.com/path?token=private',subscription:'secret',cookie:'session=secret',profile:{node:'private'}});
    const data=fs.readFileSync(path.join(directory,'browser-diagnostics.jsonl'),'utf8');
    assert.doesNotMatch(data,/password|token|private|secret|example\.com/u);
    const record=JSON.parse(data);assert.equal(record.event,'native-target-setup-failed');assert.equal(record.message,'Error at [URL]');
    assert.equal(record.subscription,undefined);assert.equal(record.cookie,undefined);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
