import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
const require=createRequire(import.meta.url);
const root=resolve('.');
const runDir=join(root,'qa','electron-initial');
await mkdir(runDir,{recursive:true});
await access(join(root,'dist-desktop','main.cjs'));
let app;
try {
  app=await electron.launch({executablePath:require('electron'),args:[root,'--sidework-qa'],env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:join(runDir,'data')},timeout:30000});
  await expect.poll(()=>app.windows().some((p)=>p.url().endsWith('/dist-renderer/index.html')),{timeout:15000}).toBe(true);
  const page=app.windows().find((p)=>p.url().endsWith('/dist-renderer/index.html'));
  assert(page);
  await page.waitForFunction(()=>Boolean(window.sidework),null,{timeout:15000});
  await expect.poll(async()=> (await page.evaluate(()=>window.sidework.getState())).bridgeReady,{timeout:15000}).toBe(true);
  const state=await page.evaluate(()=>window.sidework.getState());
  assert(state.profiles.length>0,'A real browser profile must exist');
  await writeFile(join(runDir,'result.json'),JSON.stringify({bridge:true,profiles:state.profiles.length},null,2));
  console.log('Electron initial bridge PASS');
} finally {await app?.close();}
