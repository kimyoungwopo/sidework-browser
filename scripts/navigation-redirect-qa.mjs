import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve('.');const dir=await mkdtemp(join(root,'qa','navigation-redirect-'));let app;let page;const sockets=new Set();
const server=createServer((req,res)=>{
 if(req.url==='/hold'){return;}
 if(req.url==='/broken'){req.socket.destroy();return;}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'});
 res.end(req.url==='/redirect'?'<title>redirect</title><script>location.replace("/final")</script><img src="/hold">':'<title>Redirect complete</title><h1 id="proof">실제 최종 페이지</h1>');
});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
async function state(){return page.evaluate(()=>window.sidework.getState());}
async function navigate(url){await page.getByLabel('주소 또는 검색어',{exact:true}).fill(url);await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');}
try{
 const exe=process.env.SIDEWORK_QA_EXECUTABLE;
 app=await electron.launch({executablePath:exe??join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:exe?['--sidework-qa']:[root,'--sidework-qa'],env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:join(dir,'data')},timeout:30000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);await expect.poll(async()=>(await state()).bridgeReady).toBe(true);
 await app.evaluate(({webContents})=>{globalThis.navigationQa=[];for(const w of webContents.getAllWebContents())if(w.getURL()==='about:blank'){w.on('did-fail-load',(_e,code,description,url,main)=>globalThis.navigationQa.push({event:'did-fail-load',code,description,url,main}));w.on('did-fail-provisional-load',(_e,code,description,url,main)=>globalThis.navigationQa.push({event:'did-fail-provisional-load',code,description,url,main}));}});
 await navigate(origin+'/redirect');
 await expect.poll(()=>app.evaluate(async({webContents},url)=>{const w=webContents.getAllWebContents().find(w=>w.getURL()===url+'/final');return w?await w.executeJavaScript('document.querySelector("#proof")?.textContent'):null;},origin),{timeout:15000}).toBe('실제 최종 페이지');
 await page.waitForTimeout(500);
 const events=await app.evaluate(()=>globalThis.navigationQa);await writeFile(join(dir,'events.json'),JSON.stringify(events,null,2));
 await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeHidden();console.log('PASS real client redirect finishes with no false error/sidebar');
 await navigate(origin+'/broken');await expect(page.getByRole('alert')).toBeVisible({timeout:15000});console.log('PASS real connection failure remains visible');
 await navigate(origin+'/final');await expect.poll(async()=>{const s=await state();const t=s.tabs.find(t=>t.id===s.activeTabId);return t.url===origin+'/final'&&!t.error;}).toBe(true);await expect(page.getByRole('alert')).toHaveCount(0);console.log('PASS successful recovery clears the previous page error');
 await writeFile(join(dir,'result.json'),JSON.stringify({status:'PASS',events,redirectNoFalseError:true,realNetworkFailureVisible:true,recoveryClearsError:true},null,2));console.log('NAVIGATION REGRESSION PASS',dir);
}catch(error){await writeFile(join(dir,'failure.json'),JSON.stringify({error:String(error),alerts:page?await page.getByRole('alert').allTextContents().catch(()=>[]):[],state:page?await state().catch(()=>null):null},null,2));console.error(error);console.log('Evidence',dir);process.exitCode=1;}finally{await app?.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
