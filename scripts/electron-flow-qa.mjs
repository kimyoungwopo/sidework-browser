import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
const require=createRequire(import.meta.url);
const root=resolve('.');
const runDir=await mkdtemp(join(root,'qa','flow-'));
const dataDir=join(runDir,'data');await mkdir(dataDir);
const results={fixture:'explicit synthetic local webpage; no personal account or public side effects',checks:[],jobs:[],screenshots:[],dataDir};
let app;let page;let fixtureWebContentsId;
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>Sidework · 브라우저 검증실</title><style>body{margin:0;background:#fafbfc;color:#192435;font:16px -apple-system,BlinkMacSystemFont,sans-serif}.wrap{max-width:700px;margin:60px auto;padding:40px}small{color:#59697b}h1{font-size:34px;letter-spacing:-1.2px;margin:18px 0}p{line-height:1.8}.sample{margin:30px 0;padding:25px;border:1px solid #dce3eb;border-radius:16px;background:white}button{background:#165dd9;color:white;border:0;padding:12px 20px;border-radius:9px;font-size:15px;cursor:pointer}output{font-size:35px;font-weight:650;margin-left:25px}label{display:block;margin:18px 0 8px}input{padding:10px;border:1px solid #b9c5d4;border-radius:7px}a{color:#165dd9}</style><div class="wrap"><small>Sidework 자체 테스트용 합성 자료 · 외부 전송/계정 작업 없음</small><h1>실제 페이지에서, 실제로.</h1><p>이 화면은 이미지나 미리보기가 아닌 네이티브 브라우저의 웹페이지입니다.<br>AI는 페이지를 읽고, 승인을 받은 행동만 실행합니다.</p><div class="sample"><h2>페이지 읽기</h2><p>사과는 빨강입니다. 바나나는 노랑입니다.</p></div><div class="sample"><h2>승인 후 행동</h2><p>버튼은 이 페이지 안의 숫자만 변경합니다.</p><button id="increment">카운터 증가</button><output id="counter">0</output><label for="note">테스트 메모</label><input id="note" aria-label="테스트 메모" placeholder="일반 입력"><label for="password">합성 민감 입력 테스트</label><input id="password" type="password" value="SYNTHETIC_SECRET_NOT_REAL"></div><a href="/next">다음 테스트 페이지</a></div><script>document.getElementById('increment').onclick=()=>{const c=document.getElementById('counter');c.textContent=String(Number(c.textContent)+1);};</script></html>`;
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(req.url==='/next'?'<title>두 번째 페이지</title><h1>두 번째 테스트 페이지</h1><a href="/">돌아가기</a>':fixture);});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
async function state(){return page.evaluate(()=>window.sidework.getState());}
async function dispatch(command){return page.evaluate(request=>window.sidework.dispatch(request),command);}
async function waitState(predicate,timeout=15000){await expect.poll(async()=>predicate(await state()),{timeout,intervals:[100,200,400,800]}).toBe(true);return state();}
async function launch(){
 const executable=process.env.SIDEWORK_QA_EXECUTABLE??require('electron');
 const args=process.env.SIDEWORK_QA_EXECUTABLE?['--sidework-qa']:[root,'--sidework-qa'];
 app=await electron.launch({executablePath:executable,args,cwd:process.env.SIDEWORK_QA_EXECUTABLE?dirname(executable):root,env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:dataDir},timeout:30000});
 await expect.poll(()=>app.windows().some(p=>p.url().includes('/dist-renderer/index.html')),{timeout:15000}).toBe(true);
 page=app.windows().find(p=>p.url().includes('/dist-renderer/index.html'));assert(page);
 await waitState(s=>s.bridgeReady&&s.profiles.length>0);
}
async function nativeEval(id,code){return app.evaluate(({webContents},{id,code})=>{const wc=webContents.fromId(id);if(!wc)throw new Error('QA target no longer exists');return wc.executeJavaScript(code);},{id,code});}
async function nativeContents(){return app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL(),preferences:w.getLastWebPreferences()})));}
async function capture(name,width){
 if(width)await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,930),width);
 await page.waitForTimeout(200);
 const sourceId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getMediaSourceId());
 const match=/^window:(\d+):/.exec(sourceId);assert(match,'owned native window ID required');
 const path=join(runDir,name);
 try {
  await execFileAsync('/usr/sbin/screencapture',['-x','-o','-l',match[1],path],{timeout:20000});
  assert((await stat(path)).size>1000,'native window PNG required');results.screenshots.push(path);
 } catch(error) {
  results.nativeCompositeCapture={status:'BLOCKED',reason:'OS window capture unavailable; cua-driver daemon unavailable; Hermes computer_use import failure. Separate actual component captures below are NOT a native composite.'};
  const shell=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  const shellPath=path.replace('.png','-shell-only.png');await writeFile(shellPath,Buffer.from(shell,'base64'));
  const native=await app.evaluate(async({webContents},id)=>(await webContents.fromId(id).capturePage()).toPNG().toString('base64'),fixtureWebContentsId);
  const nativePath=path.replace('.png','-webview-only.png');await writeFile(nativePath,Buffer.from(native,'base64'));results.screenshots.push(shellPath,nativePath);
  await writeFile(path+'.capture.json',JSON.stringify({error:String(error),window:await app.evaluate(({BrowserWindow})=>({visible:BrowserWindow.getAllWindows()[0].isVisible(),bounds:BrowserWindow.getAllWindows()[0].getBounds()}))}));
 }
 return path;
}
async function startViaUI(prompt){
 if(!await page.getByLabel('AI에게 요청',{exact:true}).isVisible())await page.getByRole('button',{name:'어시스턴트',exact:true}).click();
 await page.getByLabel('AI에게 요청',{exact:true}).fill(prompt);
 await page.getByRole('button',{name:'실행',exact:true}).click();
 const s=await waitState(s=>Boolean(s.activeJobId),15000);return s.activeJobId;
}
async function waitJob(id,states,timeout=120000){await expect.poll(async()=>{const job=(await state()).jobs.find(j=>j.id===id);return job&&states.includes(job.status);},{timeout,intervals:[200,400,800,1000]}).toBe(true);return (await state()).jobs.find(j=>j.id===id);}
function mark(name,detail={}){results.checks.push({name,status:'PASS',...detail});console.log('PASS',name);}
try {
 await launch();
 const initial=await state();assert.equal(initial.jobs.length,0);mark('no synthetic jobs in real initial state');
 await page.getByLabel('주소 또는 검색어',{exact:true}).fill(origin+'/');await page.getByLabel('주소 또는 검색어',{exact:true}).press('Enter');
 await waitState(s=>s.tabs.some(t=>t.id===s.activeTabId&&t.url===origin+'/'&&!t.isLoading));
 const first=(await nativeContents()).filter(c=>c.url===origin+'/');assert.equal(first.length,1);const firstId=first[0].id;fixtureWebContentsId=firstId;
 assert.equal(first[0].preferences.nodeIntegration,false);assert.equal(first[0].preferences.sandbox,true);assert.equal(first[0].preferences.contextIsolation,true);
 assert.equal(await nativeEval(firstId,'typeof window.sidework'), 'undefined');assert.equal(await nativeEval(firstId,'typeof require'),'undefined');
 mark('real native navigation and remote-page IPC isolation');
 await nativeEval(firstId,"localStorage.setItem('sidework-qa','profile-a');document.cookie='sideworkqa=profile-a;path=/'");
 await page.getByRole('button',{name:'새 탭',exact:true}).click();await waitState(s=>s.tabs.filter(t=>t.profileId===s.activeProfileId).length===2);mark('new tab UI creates a real browser tab');
 const originalTab=initial.tabs[0].id;await dispatch({type:'tab.activate',tabId:originalTab});
 await page.getByTestId('profile-menu').click();await page.getByLabel('프로필 이름',{exact:true}).fill('검증 프로필');await page.getByRole('button',{name:'프로필 만들기',exact:true}).click();
 const withProfile=await waitState(s=>s.profiles.length===2);const secondProfile=withProfile.profiles.find(p=>p.id!=='default');assert(secondProfile);await page.getByTestId('profile-'+secondProfile.id).click();
 await waitState(s=>s.activeProfileId===secondProfile.id);await dispatch({type:'tab.navigate',url:origin+'/'});await waitState(s=>s.tabs.some(t=>t.id===s.activeTabId&&t.url===origin+'/'&&!t.isLoading));
 const second=(await nativeContents()).filter(c=>c.url===origin+'/'&&c.id!==firstId);assert.equal(second.length,1);const secondId=second[0].id;
 assert.equal(await nativeEval(secondId,"localStorage.getItem('sidework-qa')"),null);assert.equal(await nativeEval(secondId,"document.cookie.includes('sideworkqa=profile-a')"),false);await expect(page.getByRole('alert')).toHaveCount(0);mark('real cookie/localStorage profile isolation and no aborted-navigation UI error');
 await dispatch({type:'profile.activate',profileId:'default'});await dispatch({type:'tab.activate',tabId:originalTab});
 assert.equal(await nativeEval(firstId,"localStorage.getItem('sidework-qa')"),'profile-a');
 await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByLabel('개인 메모리 사용',{exact:true}).click();await waitState(s=>s.settings.memoryEnabled);await page.getByLabel('저장할 메모',{exact:true}).fill('합성 QA 메모: 답변은 짧게');await page.getByRole('button',{name:'메모 저장',exact:true}).click();await waitState(s=>s.memory.length===1);await page.getByLabel('개인 메모리 사용',{exact:true}).click();await waitState(s=>!s.settings.memoryEnabled);mark('memory UI opt-in save and off');
 await page.getByRole('button',{name:'어시스턴트',exact:true}).click();
 const summaryId=await startViaUI('이 페이지에서 사과와 바나나의 색상만 한국어로 정리하고 끝내세요. 페이지 변경이나 다른 도구는 필요 없습니다.');
 const summary=await waitJob(summaryId,['completed','failed','unknown']);assert.equal(summary.status,'completed',JSON.stringify(summary));assert(summary.answer.includes('사과')&&summary.answer.includes('바나나'));assert.equal((await state()).providerStatus.liveVerified,true);results.jobs.push(summary);mark('real UI -> local worker -> live Codex -> verified answer');
 const actionId=await startViaUI('현재 페이지의 카운터 증가 버튼을 정확히 한 번 클릭하세요. 승인 후 숫자가 1인지 확인하고, 스크린샷을 한 장 저장한 다음 결과를 답하고 끝내세요. 다른 페이지로 이동하지 마세요.');
 await page.getByRole('button',{name:'사이드바 닫기',exact:true}).click();
 const awaiting=await waitJob(actionId,['awaiting_approval','completed','failed']);await expect(page.getByLabel('Sidework 작업 패널',{exact:true})).toBeVisible();assert.equal(awaiting.status,'awaiting_approval',JSON.stringify(awaiting));assert.equal(await nativeEval(firstId,"document.getElementById('counter').textContent"),'0');
 await expect(page.getByRole('button',{name:'이번 행동 허용',exact:true})).toBeInViewport();await expect(page.getByRole('button',{name:'거부',exact:true})).toBeInViewport();
 await capture('approval-1440.png',1440);
 await page.getByRole('button',{name:'이번 행동 허용',exact:true}).click();
 const actionJob=await waitJob(actionId,['completed','failed','unknown'],180000);assert.equal(actionJob.status,'completed',JSON.stringify(actionJob));assert.equal(await nativeEval(firstId,"document.getElementById('counter').textContent"),'1');assert.equal(actionJob.artifacts.length,1);const png=await readFile(actionJob.artifacts[0].path);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert((await stat(actionJob.artifacts[0].path)).size>1000);results.jobs.push(actionJob);mark('approval blocks mutation until user click; one mutation and real screenshot artifact');
 await capture('complete-1440.png',1440);await capture('complete-1100.png',1100);
 const staleId=await startViaUI('카운터 증가 버튼을 정확히 한 번 클릭한 뒤 끝내세요. 다른 행동은 하지 마세요.');
 const stale=await waitJob(staleId,['awaiting_approval','failed','completed']);assert.equal(stale.status,'awaiting_approval');
 await nativeEval(firstId,"document.querySelector('h1').textContent='승인 이후 변경된 문서'");
 let rejected=false;try{await dispatch({type:'job.approve',jobId:staleId,approvalId:stale.approval.id,allow:true});}catch{rejected=true;}
 assert(rejected);await waitJob(staleId,['failed','cancelled']);assert.equal(await nativeEval(firstId,"document.getElementById('counter').textContent"),'1');mark('DOM changed after approval request is rejected without second click');
 const cancelId=await startViaUI('페이지 내용을 자세히 분석해 주세요.');await page.getByRole('button',{name:'중지',exact:true}).click();const cancelled=await waitJob(cancelId,['cancelled','unknown']);assert.equal(cancelled.status,'cancelled');mark('UI cancellation terminates active job without fabricated completion');
 const beforeRestart=await state();await app.close();app=null;await launch();const restored=await state();assert.equal(restored.jobs.length,beforeRestart.jobs.length);assert.equal(restored.memory.length,1);assert.equal(restored.settings.memoryEnabled,false);assert.equal(restored.profiles.length,2);assert.equal(restored.activeJobId,null);mark('cold restart preserves profiles, history and memory opt-out');
 await writeFile(join(runDir,'result.json'),JSON.stringify({...results,status:'PASS'},null,2));console.log('FLOW QA PASS',runDir);
} catch(error) {
 const errorText=error instanceof Error?error.stack:String(error);await writeFile(join(runDir,'failure.json'),JSON.stringify({...results,status:'FAIL',error:errorText,state:page?await state().catch(()=>null):null},null,2));console.error('FLOW QA FAIL',runDir,errorText);process.exitCode=1;
} finally {await app?.close().catch(()=>undefined);await new Promise(done=>server.close(done));}
