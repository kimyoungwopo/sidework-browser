import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve('.');const dir=await mkdtemp(join(root,'qa','foundation-startup-'));const marker=join(dir,'provider-was-called');const fixture=join(dir,'slow-provider');
await writeFile(fixture,'#!/bin/sh\nif [ "$1" = "login" ]; then\n  printf called > '+JSON.stringify(marker)+'\n  sleep 8\n  printf "Logged in (injected QA CLI fixture; not actual authentication)\\n"\n  exit 0\nfi\nexit 74\n',{mode:0o700});
let app;const started=Date.now();
try{
 const exe=process.env.SIDEWORK_QA_EXECUTABLE;
 app=await electron.launch({executablePath:exe??join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:exe?['--sidework-qa']:[root,'--sidework-qa'],cwd:process.env.SIDEWORK_QA_APP_CWD??root,env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:join(dir,'data'),SIDEWORK_CODEX_PATH:fixture},timeout:15000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:5000}).toBe(true);const page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);
 await expect.poll(async()=>(await page.evaluate(()=>window.sidework.getState())).browserReady,{timeout:5000}).toBe(true);const readyAt=Date.now()-started;
 assert.equal((await page.evaluate(()=>window.sidework.getState())).bridgeReady,false);await assert.rejects(access(marker));await expect(page.getByLabel('주소 또는 검색어',{exact:true})).toBeEnabled();
 await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',browserReadyHostElapsedMs:readyAt,providerNotInvokedDuringOrdinaryBrowsing:true,aiWorkerNotReadyOrRunning:true,injectedSlowCliSeconds:8,scope:'Injected login-only CLI fixture. No model inference or actual authentication claimed.'},null,2));console.log('STARTUP PASS',readyAt,'ms',dir);
}catch(error){await writeFile(join(dir,'failure.json'),JSON.stringify({error:String(error),elapsedMs:Date.now()-started},null,2));console.error('STARTUP FAIL',dir,String(error));process.exitCode=1;}finally{await app?.close();}
