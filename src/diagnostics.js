'use strict';
const fs=require('node:fs');
const path=require('node:path');

// Local lifecycle diagnostics only: do not serialize profiles, proxy configs,
// subscriptions, cookies or page content. Limit size and redact URL query data.
function createDiagnostics(directory,version) {
  const file=path.join(directory,'browser-diagnostics.jsonl');
  return details=>{
    try {
      fs.mkdirSync(directory,{recursive:true});
      if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024)fs.renameSync(file,file+'.previous');
      const record={time:new Date().toISOString(),version};
      for(const key of ['event','profileId','code','signal','requested','reason'])if(details[key]!==undefined)record[key]=details[key];
      if(details.message)record.message=String(details.message).replace(/(?:https?|socks5?):\/\/\S+/giu,'[URL]').slice(0,2000);
      fs.appendFileSync(file,JSON.stringify(record)+'\n','utf8');
    }catch{/* Logging must never terminate a browser. */}
  };
}
module.exports={createDiagnostics};
