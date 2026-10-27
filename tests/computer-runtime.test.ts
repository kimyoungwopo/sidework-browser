import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import { validatePlan, validateSnapshot } from '../src/core/validation.ts';
import type { BrowserPort, Planner, CoreSnapshot, Observation, BrowserAction } from '../src/contract.ts';
const base: Observation = { profileId:'p', tabId:'t', revision:1, url:'https://example.test/', title:'Page', text:'Public', elements:[], capturedAt:'now' };
async function until(predicate:()=>boolean) { for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));} assert.fail('Timed out'); }
async function fixture(planner:Planner, browser?:BrowserPort) {
 const root=await mkdtemp(join(tmpdir(),'computer-core-')); const changes:CoreSnapshot[]=[];
 const store=new RuntimeStore(root);
 const runtime=new AgentRuntime({store,planner,browser:browser??{observe:async c=>({...structuredClone(base),...c}),execute:async (_a,c)=>({context:c,message:'Done'})},onChange:s=>changes.push(s)});
 await runtime.initialize();return {runtime,store,root,changes,close:async()=>{await runtime.shutdown();await rm(root,{recursive:true,force:true});}};
}
const screen={frameId:'frame-1',width:100,height:80,viewportWidth:200,viewportHeight:160,pngBase64:'EPHEMERAL_PIXELS',safeLinks:[]};

test('computer click/type/key require independent approval and stale frames reject even after approval',async()=>{
 for(const action of [{type:'computer_click',x:10,y:10,frameId:'frame-1'},{type:'computer_type',value:'private-computer-text',frameId:'frame-1'},{type:'computer_key',key:'Enter',frameId:'frame-1'}] as BrowserAction[]){
  for(const stale of [false,true]){
   let plans=0,executions=0;let frame='frame-1';
   const f=await fixture({next:async()=>++plans===1?{thought:'Interact',action}:{thought:'Done',action:{type:'finish',text:'Done'}}},{observe:async c=>({...structuredClone(base),...c,screen:{...screen,frameId:frame}}),execute:async(_a,c)=>{executions++;return {context:c,message:'Done'};}});
   try{
    const id=await f.runtime.start({...task(),computerUse:true,shareScreen:true});
    await until(()=>f.runtime.snapshot().jobs[0]!.status!=='running');
    const pending=f.runtime.snapshot().jobs[0]!.approval;
    assert.ok(pending,'Computer mutation must await approval');assert.equal(executions,0);
    if(stale)frame='frame-2';
    if(stale)await assert.rejects(f.runtime.approve({jobId:id,approvalId:pending.id,allow:true}));
    else await f.runtime.approve({jobId:id,approvalId:pending.id,allow:true});
    await until(()=>f.runtime.snapshot().activeJobId===null);
    assert.equal(executions,stale?0:1);
    assert.equal(f.runtime.snapshot().jobs[0]!.status,stale?'failed':'completed');
   }finally{await f.close();}
  }
 }
});

const task=(tabId='t')=>({prompt:'Read',profileId:'p',tabId});

test('computer capability fails closed without consent, in read-only, for open_tab and out-of-frame targets',async()=>{
 const click:BrowserAction={type:'computer_click',x:10,y:10,frameId:'frame-1'};
 for(const scenario of ['legacy','read-only','open-tab','bounds','missing-screen']){
  const action:BrowserAction=scenario==='open-tab'?{type:'open_tab',url:'https://example.test/read'}:scenario==='bounds'?{...click,x:110}:click;
  let executions=0;
  const f=await fixture({next:async()=>({thought:'Try',action})},{observe:async c=>({...structuredClone(base),...c,...(scenario==='missing-screen'?{}:{screen})}),execute:async(_a,c)=>{executions++;return {context:c,message:'Done'};}});
  try{
   if(scenario==='read-only')await f.runtime.updateSettings({permissionMode:'read-only'});
   await f.runtime.start({...task(),...(scenario==='legacy'?{}:{computerUse:true,shareScreen:true})});
   await until(()=>f.runtime.snapshot().jobs[0]!.status!=='running');
   assert.equal(f.runtime.snapshot().jobs[0]!.approval,null,scenario);
   assert.equal(f.runtime.snapshot().jobs[0]!.status,'failed',scenario);
   assert.equal(executions,0);
  }finally{await f.close();}
 }
});

test('computer safe same-origin navigation and safe-link selection are automatic; risky links and legacy nav still require approval',async()=>{
 for(const scenario of ['navigate','link','risky','external','legacy']){
  const action:BrowserAction=scenario==='link'?{type:'computer_click',x:10,y:10,frameId:'frame-1'}:{type:'navigate',url:scenario==='risky'?'https://example.test/delete':scenario==='external'?'https://other.test/read':'https://example.test/read'};
  let plans=0,executions=0;
  const f=await fixture({next:async()=>++plans===1?{thought:'Read',action}:{thought:'Done',action:{type:'finish',text:'Read'}}},{observe:async c=>({...structuredClone(base),...c,screen:{...screen,safeLinks:[{x:0,y:0,width:20,height:20,url:'https://example.test/read'}]}}),execute:async(_a,c)=>{executions++;return {context:c,message:'Done'};}});
  try{
   await f.runtime.start({...task(),...(scenario==='legacy'?{}:{computerUse:true,shareScreen:true})});
   await until(()=>f.runtime.snapshot().jobs[0]!.status!=='running');
   if(['navigate','link'].includes(scenario)){
    assert.equal(f.runtime.snapshot().jobs[0]!.approval,null);
    assert.equal(f.runtime.snapshot().jobs[0]!.status,'completed');assert.equal(executions,1);
   }else{assert.ok(f.runtime.snapshot().jobs[0]!.approval);assert.equal(executions,0);}
  }finally{await f.close();}
 }
});

test('one persistence failure stops every concurrent job and rejects further execution',async()=>{
 const signals:AbortSignal[]=[]; let plans=0;
 const f=await fixture({next:async i=>{plans++;signals.push(i.signal);return new Promise(()=>{});}});
 try{
  await Promise.all(['a','b','c'].map(t=>f.runtime.start(task(t))));
  await until(()=>plans===3);
  f.store.save=async()=>{throw new Error('private filesystem path');};
  await assert.rejects(f.runtime.updateSettings({maxSteps:3}));
  await until(()=>f.runtime.snapshot().activeJobId===null);
  assert.ok(signals.every(s=>s.aborted));
  assert.ok(f.runtime.snapshot().jobs.every(j=>j.status==='failed'&&j.answer===null&&j.approval===null));
  assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('private filesystem path'));
  await assert.rejects(f.runtime.start(task('new')),/closed/i);
 }finally{await f.close();}
});

test('concurrent approvals, secret redaction, unknown outcomes and memory-off remain job-local',async()=>{
 const counts=new Map<string,number>();const calls:string[]=[];
 const f=await fixture({next:async i=>{
  assert.deepEqual(i.memory,[]);const tab=i.observation.tabId;const count=(counts.get(tab)??0)+1;counts.set(tab,count);
  return count===1?{thought:`type ${tab}-private`,action:{type:'computer_type',value:`${tab}-private`,frameId:'frame-1'}}:{thought:'Done',action:{type:'finish',text:'Done'}};
 }},{observe:async c=>({...structuredClone(base),...c,text:`${c.tabId}-private other-private`,screen}),execute:async(_a,c)=>{calls.push(c.tabId);if(c.tabId==='a')throw new Error('transport details');return {context:c,message:'Done'};}});
 try{
  await f.runtime.addMemory('Opt in only');
  const [a,b,c]=await Promise.all(['a','b','c'].map(tab=>f.runtime.start({...task(tab),computerUse:true,shareScreen:true})));
  await until(()=>f.runtime.snapshot().jobs.every(j=>j.status==='awaiting_approval'));
  const approval=(id:string)=>f.runtime.snapshot().jobs.find(j=>j.id===id)!.approval!;
  await assert.rejects(f.runtime.approve({jobId:a!,approvalId:approval(b!).id,allow:true}));
  await f.runtime.cancel(c!);
  assert.equal(f.runtime.snapshot().jobs.find(j=>j.id===b)!.status,'awaiting_approval');
  await Promise.all([a,b].map(id=>f.runtime.approve({jobId:id!,approvalId:approval(id!).id,allow:true})));
  await until(()=>f.runtime.snapshot().activeJobId===null);
  assert.equal(f.runtime.snapshot().jobs.find(j=>j.id===a)!.status,'unknown');
  assert.equal(f.runtime.snapshot().jobs.find(j=>j.id===b)!.status,'completed');
  assert.equal(f.runtime.snapshot().jobs.find(j=>j.id===c)!.status,'cancelled');
  assert.deepEqual(calls.sort(),['a','b']);
  for(const job of f.runtime.snapshot().jobs){assert.ok(!JSON.stringify(job.events).includes(`${job.tabId}-private`));assert.ok(JSON.stringify(job.events).includes('other-private'));}
 }finally{await f.close();}
});

test('screen bytes echoed by observation or planner never persist in history or answers; DOM-only strips accidental screen input',async()=>{
 for(const computerUse of [true,false]){
  let sawImage=false;
  const f=await fixture({next:async i=>{sawImage=!!i.observation.screen;return {thought:screen.pngBase64,action:{type:'finish',text:`Read ${screen.pngBase64}`}};}},{observe:async c=>({...structuredClone(base),...c,text:`Public ${screen.pngBase64}`,screen}),execute:async()=>{assert.fail('No action');}});
  try{
   await f.runtime.start({...task(),...(computerUse?{computerUse:true,shareScreen:true}:{})});
   await until(()=>f.runtime.snapshot().activeJobId===null);await f.runtime.shutdown();
   assert.equal(sawImage,computerUse);
   assert.ok(!JSON.stringify(await f.store.load()).includes(screen.pngBase64));
  }finally{await f.close();}
 }
});

test('snapshot validation accepts legacy and optional computer state but rejects extra fields, invalid consent and malformed active IDs',async()=>{
 const f=await fixture({next:async()=>({thought:'Done',action:{type:'finish',text:'Done'}})});
 try{
  await f.runtime.start({...task(),computerUse:true,shareScreen:true});
  await until(()=>f.runtime.snapshot().activeJobId===null);await f.runtime.shutdown();
  const current=f.runtime.snapshot();assert.deepEqual(validateSnapshot(current),current);
  const legacy=structuredClone(current);delete legacy.activeJobIds;delete legacy.jobs[0]!.computerUse;delete legacy.jobs[0]!.shareScreen;
  assert.deepEqual(validateSnapshot(legacy),legacy);
  for(const change of [(s:CoreSnapshot)=>Object.assign(s,{screen}), (s:CoreSnapshot)=>Object.assign(s.jobs[0]!,{screen}),(s:CoreSnapshot)=>Object.assign(s.jobs[0]!,{computerUse:'true'}),(s:CoreSnapshot)=>{s.jobs[0]!.shareScreen=false;},(s:CoreSnapshot)=>{s.activeJobIds=['duplicate','duplicate'];s.activeJobId='duplicate';},(s:CoreSnapshot)=>{s.activeJobIds=['x'];s.activeJobId=null;},(s:CoreSnapshot)=>{s.activeJobIds=Array.from({length:9},(_,i)=>String(i));s.activeJobId='0';}]){const invalid=structuredClone(current);change(invalid);assert.throws(()=>validateSnapshot(invalid));}
 }finally{await f.close();}
});

test('concurrent publications are immutable ordered snapshots and shutdown awaits terminal writes',async()=>{
 const f=await fixture({next:async()=>({thought:'Done',action:{type:'finish',text:'Done'}})});
 try{
  const realSave=f.store.save.bind(f.store);let release:()=>void=()=>{};let saves=0;let releaseSet=false;
  f.store.save=async snapshot=>{if(++saves===1){await new Promise<void>(r=>{release=r;releaseSet=true;});}await realSave(snapshot);};
  const first=f.runtime.addMemory('first');await until(()=>releaseSet);
  const second=f.runtime.addMemory('second');
  await new Promise(r=>setTimeout(r,10));assert.equal(saves,1);
  release();await Promise.all([first,second]);
  assert.deepEqual(f.changes.slice(-2).map(s=>s.memory.map(m=>m.text)),[['first'],['first','second']]);
  assert.deepEqual(await f.store.load(),f.runtime.snapshot());
  await f.runtime.start(task());await until(()=>f.runtime.snapshot().activeJobId===null);
  await f.runtime.shutdown();assert.deepEqual(await f.store.load(),f.runtime.snapshot());
 }finally{await f.close();}
});

test('shutdown aborts all eight jobs; fresh runtime interrupts every persisted active job without resuming',async()=>{
 const signals:AbortSignal[]=[];
 const f=await fixture({next:async i=>{signals.push(i.signal);return new Promise(()=>{});}});
 try{
  await Promise.all(Array.from({length:8},(_,i)=>f.runtime.start(task(`r${i}`))));
  await until(()=>signals.length===8);
  const interrupted=f.runtime.snapshot();
  await f.runtime.shutdown();assert.ok(signals.every(s=>s.aborted));
  assert.ok(f.runtime.snapshot().jobs.every(j=>j.status==='cancelled'));
  interrupted.jobs[0]!.status='queued';
  await f.store.save(interrupted);
  const recovered=new AgentRuntime({store:new RuntimeStore(f.root),planner:{next:async()=>{assert.fail('No automatic resume');}},browser:{observe:async()=>{assert.fail('No browser on restart');},execute:async()=>{assert.fail('No action');}},onChange:()=>{}});
  await recovered.initialize();
  assert.deepEqual(recovered.snapshot().activeJobIds,[]);assert.equal(recovered.snapshot().activeJobId,null);
  assert.equal(recovered.snapshot().jobs.length,8);
  assert.ok(recovered.snapshot().jobs.every(j=>j.status==='interrupted'&&j.approval===null));
  assert.deepEqual(await f.store.load(),recovered.snapshot());await recovered.shutdown();
 }finally{await f.close();}
});

test('typed and filled secrets never appear in exposed or persisted approvals while execution keeps the original bound value',async()=>{
 for(const computerUse of [true,false]){
  const secret='raw-value-must-stay-in-job-local-ram';let plans=0;let typed='';
  const action:BrowserAction=computerUse?{type:'computer_type',value:secret,frameId:'frame-1'}:{type:'fill',ref:'field',value:secret};
  const f=await fixture({next:async()=>++plans===1?{thought:`Use ${secret}`,action}:{thought:'Done',action:{type:'finish',text:'Done'}}},{observe:async c=>({...structuredClone(base),...c,screen,elements:[{ref:'field',tag:'input',role:'textbox',name:'Public',inputType:'text',sensitive:false}]}),execute:async(a,c)=>{if(a.type==='fill'||a.type==='computer_type')typed=a.value;return {context:c,message:'Done'};}});
  try{
   const id=await f.runtime.start({...task(),...(computerUse?{computerUse:true,shareScreen:true}:{})});
   await until(()=>!!f.changes.at(-1)?.jobs[0]!.approval);
   assert.ok(!JSON.stringify(f.runtime.snapshot()).includes(secret));
   assert.ok(!JSON.stringify(await f.store.load()).includes(secret));
   const approval=f.runtime.snapshot().jobs[0]!.approval!;
   await f.runtime.approve({jobId:id,approvalId:approval.id,allow:true});
   await until(()=>f.runtime.snapshot().activeJobId===null);
   assert.equal(typed,secret);assert.equal(f.runtime.snapshot().jobs[0]!.status,'completed');
  }finally{await f.close();}
 }
});

test('computer executor cannot retarget a running job to a different tab or profile',async()=>{
 for(const wrong of [{tabId:'other'},{profileId:'other'}]){
  let plans=0;const observed:string[]=[];
  const f=await fixture({next:async()=>++plans===1?{thought:'Read',action:{type:'navigate',url:'https://example.test/read'}}:{thought:'Done',action:{type:'finish',text:'Done'}}},{observe:async c=>{observed.push(`${c.profileId}/${c.tabId}`);return {...structuredClone(base),...c,screen};},execute:async(_a,c)=>({context:{...c,...wrong},message:'Bad context'})});
  try{
   await f.runtime.start({...task(),computerUse:true,shareScreen:true});await until(()=>f.runtime.snapshot().activeJobId===null);
   assert.equal(f.runtime.snapshot().jobs[0]!.status,'unknown');assert.equal(plans,1);
   assert.ok(observed.every(c=>c==='p/t'));
  }finally{await f.close();}
 }
});

test('computer plan shapes validate exact fields, finite image coordinates, bounded frame IDs and key whitelist',()=>{
 const valid=[{type:'computer_click',x:0,y:899,frameId:'f'},{type:'computer_type',value:'',frameId:'f'},...['Tab','Enter','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Space'].map(key=>({type:'computer_key',key,frameId:'f'}))];
 for(const action of valid)assert.deepEqual(validatePlan({thought:'Valid',action}).action,action);
 for(const action of [...[-1,1.2,NaN,Infinity,1280].map(x=>({type:'computer_click',x,y:1,frameId:'f'})),{type:'computer_click',x:1,y:900,frameId:'f'},{type:'computer_click',x:1,y:1,frameId:''},{type:'computer_click',x:1,y:1,frameId:'x'.repeat(257)},{type:'computer_click',x:1,y:1,frameId:'f',autoApproved:true},{type:'computer_type',value:1,frameId:'f'},{type:'computer_type',value:'x'.repeat(16001),frameId:'f'},...['Meta','Control','Ctrl+A','F12','a'].map(key=>({type:'computer_key',key,frameId:'f'}))]) assert.throws(()=>validatePlan({thought:'Bad',action}));
});

test('computer consent is explicit, flags reach browser/planner, images never enter persisted state',async()=>{
 const options:unknown[]=[]; const inputs:unknown[]=[];
 const screen={frameId:'frame-1',width:100,height:80,viewportWidth:200,viewportHeight:160,pngBase64:'IMAGE_BYTES_ONLY',safeLinks:[]};
 const f=await fixture({next:async i=>{inputs.push(i);assert.equal(i.computerUse,true);assert.ok(i.jobId);assert.deepEqual(i.observation.screen,screen);return {thought:'Read pixels',action:{type:'finish',text:'Done'}};}},{observe:async(c,o)=>{options.push(o);return {...structuredClone(base),...c,screen};},execute:async()=>{assert.fail('No action');}});
 try{
  for(const input of [{...task(),computerUse:true},{...task(),computerUse:true,shareScreen:false},{...task(),computerUse:'true'},{...task(),shareScreen:'yes'},{...task(),unexpected:true}]) await assert.rejects(f.runtime.start(input as Parameters<typeof f.runtime.start>[0]),/consent|screen|input/i);
  assert.equal(f.runtime.snapshot().jobs.length,0);
  const id=await f.runtime.start({...task(),computerUse:true,shareScreen:true});
  await until(()=>f.runtime.snapshot().activeJobId===null);
  assert.deepEqual(options,[{jobId:id,computerUse:true,shareScreen:true}]);
  assert.equal(inputs.length,1);
  await f.runtime.shutdown();
  const persisted=await f.store.load();
  assert.equal(persisted.jobs[0]!.computerUse,true);
  assert.equal(persisted.jobs[0]!.shareScreen,true);
  assert.ok(!JSON.stringify(persisted).includes('IMAGE_BYTES_ONLY'));
 }finally{await f.close();}
});

test('eight independent planners enter a barrier; duplicate and ninth never enter; cancel isolates and cancelAll drains',async()=>{
 const entered=new Map<string,AbortSignal>();
 const f=await fixture({next:async i=>{entered.set(i.observation.tabId,i.signal);return new Promise(()=>{});}});
 try{
  const ids=await Promise.all(Array.from({length:8},(_,i)=>f.runtime.start(task(`t${i}`))));
  await until(()=>entered.size===8);
  assert.deepEqual(f.runtime.snapshot().activeJobIds,ids);
  assert.equal(f.runtime.snapshot().activeJobId,ids[0]);
  await assert.rejects(f.runtime.start(task('t0')),/busy|duplicate/i);
  await assert.rejects(f.runtime.start(task('ninth')),/eight|8|limit|busy/i);
  assert.equal(entered.size,8);
  await f.runtime.cancel(ids[3]!);
  assert.equal(entered.get('t3')!.aborted,true);
  assert.equal(entered.get('t4')!.aborted,false);
  assert.equal(f.runtime.snapshot().activeJobIds!.length,7);
  await f.runtime.cancelAll();
  assert.deepEqual(f.runtime.snapshot().activeJobIds,[]);
  assert.ok(f.runtime.snapshot().jobs.every(j=>j.status==='cancelled'));
  assert.deepEqual(await f.store.load(),f.runtime.snapshot());
 }finally{await f.close();}
});
