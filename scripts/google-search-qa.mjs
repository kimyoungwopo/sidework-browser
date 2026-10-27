import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const root=resolve('.');const dir=await mkdtemp(join(root,'qa','google-search-'));let app;let page;
const routes=[];
async function state(){return page.evaluate(()=>window.sidework.getState());}
async function assertGoogle(query){
 await expect.poll(async()=>{const s=await state();const t=s.tabs.find(t=>t.id===s.activeTabId);try{const u=new URL(t.url);return u.hostname==='www.google.com'&&u.pathname==='/search'&&u.searchParams.get('q')===query;}catch{return false;}},{timeout:30000}).toBe(true);
 await expect.poll(()=>app.evaluate(async({webContents},query)=>{const w=webContents.getAllWebContents().find(w=>{try{const u=new URL(w.getURL());return u.hostname==='www.google.com'&&u.searchParams.get('q')===query;}catch{return false;}});return w?await w.executeJavaScript('document.readyState === "complete" && (document.querySelector("textarea[name=q],input[name=q]")?.value === '+JSON.stringify(query)+')'):false;},query),{timeout:30000}).toBe(true);
 await page.waitForTimeout(2000);await expect(page.getByRole('alert')).toHaveCount(0);
 const s=await state();const url=s.tabs.find(t=>t.id===s.activeTabId).url;routes.push({query,url,renderedSearchField:true,noErrorBanner:true});
}
try{
 app=await electron.launch({executablePath:resolve('release-navigation/mac-arm64/Sidework.app/Contents/MacOS/Sidework'),args:['--sidework-qa'],env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:join(dir,'data')},timeout:30000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);
 await expect.poll(async()=>(await state()).bridgeReady,{timeout:15000}).toBe(true);assert.equal((await state()).appVersion,'0.2.2');
 await page.getByLabel('주소 또는 검색어',{exact:true}).fill('구글');await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');await assertGoogle('구글');console.log('PASS address bar text -> real Google search URL');
 await page.getByRole('button',{name:'새 탭',exact:true}).click();await expect(page.getByLabel('새 탭 검색 또는 주소',{exact:true})).toBeVisible();await page.getByLabel('새 탭 검색 또는 주소',{exact:true}).fill('브라우저');await page.getByRole('button',{name:'검색 또는 주소 열기',exact:true}).click();await assertGoogle('브라우저');console.log('PASS new-tab search -> real Google search URL');
 const s=await state();await page.getByLabel('주소 또는 검색어',{exact:true}).fill(s.tabs.find(t=>t.id===s.activeTabId).url);await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');await assertGoogle('브라우저');console.log('PASS repeated navigation to the loaded Google URL has no stale ERR_ABORTED banner');
 const winId=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();return w.getMediaSourceId().split(':')[1];});await page.waitForTimeout(700);await exec('/usr/sbin/screencapture',['-x','-o','-l',winId,join(dir,'google-no-false-error.png')]);
 await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',version:'0.2.2',routes,scope:'Real packaged app UI, rendered Google search fields, and absence of false error banners; no CAPTCHA/sign-in bypass.'},null,2));console.log('GOOGLE SEARCH QA PASS',dir);
}catch(e){await writeFile(join(dir,'failure.json'),JSON.stringify({error:String(e),routes,state:page?await state().catch(()=>null):null},null,2));console.error(e);process.exitCode=1;}finally{await app?.close();}
