import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const executable=process.env.SIDEWORK_QA_EXECUTABLE;
assert(executable,'Set the actual extracted app executable');
const dataDir=await mkdtemp(join(tmpdir(), 'sidework-clean-launch-'));
let app;
try {
 app=await electron.launch({executablePath:executable,args:['--sidework-qa'],cwd:dirname(executable),env:{...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:dataDir},timeout:30000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);
 const page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);
 await expect.poll(async()=>(await page.evaluate(()=>window.sidework.getState())).bridgeReady,{timeout:15000}).toBe(true);
 const state=await page.evaluate(()=>window.sidework.getState());assert.equal(state.jobs.length,0);assert.equal(state.memory.length,0);assert.equal(state.settings.memoryEnabled,false);assert.equal(state.providerStatus.installed,true);assert.equal(state.providerStatus.authenticated,true);assert.equal(state.providerStatus.liveVerified,false);
 await page.getByRole('button',{name:'설정',exact:true}).click();await expect(page.getByLabel('개인 메모리 사용',{exact:true})).toBeVisible();
 await page.getByLabel('주소 또는 검색어',{exact:true}).fill('https://example.com/');await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');
 await expect.poll(async()=>(await page.evaluate(()=>window.sidework.getState())).tabs.some(t=>t.url==='https://example.com/'&&!t.isLoading),{timeout:30000}).toBe(true);
 const remote=await app.evaluate(async({webContents})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL()==='https://example.com/');if(!wc)throw new Error('missing real HTTPS content');return {text:await wc.executeJavaScript('document.body.innerText'),nodeType:await wc.executeJavaScript('typeof require'),bridgeType:await wc.executeJavaScript('typeof window.sidework')};});
 await writeFile(join('qa','extracted-package-navigation.json'),JSON.stringify(remote,null,2));
 assert(remote.text.includes('This domain is for use in documentation examples'));assert.equal(remote.nodeType,'undefined');assert.equal(remote.bridgeType,'undefined');
 const appPath=await app.evaluate(({app})=>app.getAppPath());assert(appPath.startsWith(resolve(executable,'../../Resources')));
 await writeFile(join('qa','extracted-package-smoke.json'),JSON.stringify({status:'PASS',appPath,dataDir,initialJobs:0,initialMemory:0,memoryEnabled:false,minimalPath:true,officialCliDetectedAndAuthenticated:true,modelNotInvoked:true,settingsUi:true,realPublicHttpsNavigation:'https://example.com/',remoteIpcIsolation:true},null,2));console.log('Extracted ZIP cold launch + empty state + settings + real public HTTPS PASS');
} finally {await app?.close();}
