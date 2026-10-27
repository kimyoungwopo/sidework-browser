import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const exec=promisify(execFile);const root=resolve('.');const dir=await mkdtemp(join(root,'qa','browser-first-'));
let app;let page;let winId;
const checks=[];
const mark=name=>{checks.push(name);console.log('PASS',name);};
async function state(){return page.evaluate(()=>window.sidework.getState());}
async function dispatch(c){return page.evaluate(c=>window.sidework.dispatch(c),c);}
async function settled(fn){await expect.poll(async()=>fn(await state()),{timeout:45000}).toBe(true);}
async function activeBounds(){const s=await state();const u=s.tabs.find(t=>t.id===s.activeTabId).url;return app.evaluate(({BrowserWindow},u)=>{const v=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL()===u);if(!v)throw new Error('missing actual webview');return v.getBounds();},u);}
async function capture(name){await page.waitForTimeout(300);const p=join(dir,name+'.png');await exec('/usr/sbin/screencapture',['-x','-o','-l',winId,p]);return p;}
try{
 const exe=process.env.SIDEWORK_QA_EXECUTABLE;
 app=await electron.launch({executablePath:exe??join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:exe?['--sidework-qa']:[root,'--sidework-qa'],env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:join(dir,'data')},timeout:30000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);await settled(s=>s.bridgeReady);
 winId=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({x:30,y:30,width:1440,height:930});w.show();return w.getMediaSourceId().split(':')[1];});
 await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeHidden();assert.equal(await page.locator('.workspace-rail').count(),0);assert.equal(await page.locator('.statusbar').count(),0);mark('default is browser-first: no rail, statusbar or open assistant');
 const first=(await state()).activeTabId;
 await page.getByLabel('주소 또는 검색어',{exact:true}).fill('https://developer.mozilla.org/en-US/docs/Web/JavaScript');await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');await settled(s=>s.tabs.some(t=>t.id===s.activeTabId&&t.url.includes('developer.mozilla.org')&&!t.isLoading));
 await expect.poll(async()=>{const b=await activeBounds();return b.x===0&&b.y===88&&b.width===1440&&b.height===842;}).toBe(true);mark('real public HTTPS page occupies the complete native content area');
 await app.evaluate(({webContents})=>{const w=webContents.getAllWebContents().find(w=>w.getURL().includes('developer.mozilla.org'));w.focus();w.sendInputEvent({type:'keyDown',keyCode:'L',modifiers:['meta']});w.sendInputEvent({type:'keyUp',keyCode:'L',modifiers:['meta']});});await expect(page.getByLabel('주소 또는 검색어',{exact:true})).toBeFocused();mark('Cmd+L works while the native webpage has keyboard focus');
 await page.getByRole('button',{name:'새 탭',exact:true}).click();await settled(s=>s.tabs.length===2);await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeHidden();
 await page.getByLabel('주소 또는 검색어',{exact:true}).fill('https://en.wikipedia.org/wiki/Web_browser');await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');await settled(s=>s.tabs.some(t=>t.id===s.activeTabId&&t.url.includes('en.wikipedia.org')&&!t.isLoading));await dispatch({type:'tab.activate',tabId:first});mark('new tab and tab switching preserve browser-first mode');
 await settled(s=>s.activeTabId===first);await expect(page.getByRole('tab',{name:/JavaScript/})).toHaveAttribute('aria-selected','true');
 await expect.poll(()=>app.evaluate(async({webContents})=>{const w=webContents.getAllWebContents().find(w=>w.getURL().includes('developer.mozilla.org'));return w?await w.executeJavaScript('document.readyState !== "loading" && document.body.innerText.length > 300'):false;}),{timeout:30000}).toBe(true);
 const closed=await capture('browser-full-width');
 await page.getByRole('button',{name:'어시스턴트',exact:true}).click();await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeVisible();await expect.poll(async()=>(await activeBounds()).width).toBe(1060);await page.getByLabel('AI에게 요청',{exact:true}).fill('이 페이지를 읽고 핵심만 요약해 주세요.');const opened=await capture('browser-ai-open');mark('opening AI shrinks the real webview; no overlay or hidden page');
 await page.getByRole('button',{name:'사이드바 닫기',exact:true}).click();await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeHidden();await expect.poll(async()=>(await activeBounds()).width).toBe(1440);await page.getByRole('button',{name:'어시스턴트',exact:true}).click();await expect(page.getByLabel('AI에게 요청',{exact:true})).toHaveValue('이 페이지를 읽고 핵심만 요약해 주세요.');mark('close restores full width and reopen preserves the unsent draft');
 await page.getByRole('button',{name:'사이드바 닫기',exact:true}).click();await page.getByRole('button',{name:'설정',exact:true}).click();await expect(page.getByLabel('개인 메모리 사용',{exact:true})).toBeVisible();await page.getByRole('button',{name:'사이드바 닫기',exact:true}).click();mark('settings remains available without a permanent workspace rail');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,850));await page.getByRole('button',{name:'어시스턴트',exact:true}).click();await expect.poll(async()=>(await activeBounds()).width).toBe(740);await expect(page.getByRole('button',{name:'사이드바 닫기',exact:true})).toBeInViewport();await capture('browser-1100-ai-open');mark('1100px native bounds and close control stay aligned');
 await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',checks,closed,opened},null,2));console.log('BROWSER FIRST QA PASS',dir);
}catch(e){await writeFile(join(dir,'failure.json'),JSON.stringify({error:String(e),checks,state:page?await state().catch(()=>null):null},null,2));console.error(e);process.exitCode=1;}finally{await app?.close();}
