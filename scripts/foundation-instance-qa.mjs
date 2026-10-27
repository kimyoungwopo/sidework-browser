import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
const root=resolve('.'),dir=await mkdtemp(join(root,'qa','foundation-instance-')),exe=join(root,'release-foundation/mac-arm64/Sidework.app/Contents/MacOS/Sidework');const env={...process.env,SIDEWORK_QA:'0',SIDEWORK_DATA_DIR:join(dir,'data'),SIDEWORK_CODEX_PATH:join(dir,'missing')};let app,second;
try{
 app=await electron.launch({executablePath:exe,args:[],env,timeout:15000});await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);const page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));await expect.poll(async()=>(await page.evaluate(()=>window.sidework.getState())).browserReady).toBe(true);const pid=app.process().pid;
 second=spawn(exe,[],{env,stdio:'ignore'});const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Duplicate instance did not exit')),10000);second.once('exit',code=>{clearTimeout(timer);resolve(code);});second.once('error',reject);});assert.equal(code,0);assert.equal(app.process().exitCode,null);assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);assert.equal((await page.evaluate(()=>window.sidework.getState())).bridgeReady,false);
 await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',qaMode:false,firstOwnedPid:pid,duplicateOwnedPid:second.pid,duplicateExitCode:code,firstAppStillAlive:true,windowCount:1,scope:'Same isolated app-data path, no QA bypass, no existing user app affected.'},null,2));console.log('SINGLE INSTANCE PASS',dir);
}catch(error){process.exitCode=1;console.error(error);await writeFile(join(dir,'failure.json'),JSON.stringify({error:String(error)},null,2));}finally{if(second&&second.exitCode===null)second.kill('SIGTERM');await app?.close();}
