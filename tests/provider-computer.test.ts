import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import * as provider from '../src/provider/codex.ts';
import { CodexPlanner, parsePlanOutput, PLAN_SCHEMA } from '../src/provider/codex.ts';
import { DEFAULT_SETTINGS } from '../src/contract';
import type { PlannerInput, ProviderActivity } from '../src/contract';
function crc(bytes: Buffer): number { let c=0xffffffff; for (const byte of bytes) { c^=byte; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; }
function chunk(type:string, data:Buffer):Buffer { const name=Buffer.from(type), length=Buffer.alloc(4), checksum=Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name,data]))); return Buffer.concat([length,name,data,checksum]); }
function png(width=2,height=2):Buffer { const h=Buffer.alloc(13); h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(height*(1+width*4)))),chunk('IEND',Buffer.alloc(0))]); }
const reply = (action:object={type:'finish',text:'done'}) => JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({thought:'checked',action})}});
function input(signal=new AbortController().signal):PlannerInput { return {prompt:'inspect image',computerUse:true,observation:{profileId:'p',tabId:'t',revision:1,url:'https://example.com/',title:'fixture',text:'fixture',elements:[],capturedAt:'fixture',screen:{frameId:'frame-1',width:2,height:2,viewportWidth:200,viewportHeight:200,pngBase64:png().toString('base64'),safeLinks:[]}},history:[],settings:DEFAULT_SETTINGS,memory:[],signal}; }
async function fixture(run:(dir:string)=>Promise<void>) { const dir=await mkdtemp(join(tmpdir(),'sidework-provider-computer-'));try { await run(dir); } finally { await rm(dir,{recursive:true,force:true}); } }

test('first-scroll host metadata guides a DOM plan without attaching images or changing the process budget',async()=>fixture(async dir=>{
 const i=input();i.computerUse=false;i.synchronizeFirstScroll=true;
 const planner=new CodexPlanner({binary:'injected-only',workDir:dir,maxProcesses:2,runner:async request=>{
  const context=JSON.parse(request.input.split('UNTRUSTED INPUT JSON:\n')[1]!);
  assert.equal(context.synchronizeFirstScroll,true);assert.equal(context.computerUse,false);
  assert(!request.args.includes('--image'));assert(!request.input.includes(i.observation.screen!.pngBase64));
  assert(request.input.includes('read-only DOM scroll'));
  return reply({type:'scroll',direction:'down'});
 }});
 assert.deepEqual((await planner.next(i)).action,{type:'scroll',direction:'down'});
}));

test('computer requests fail closed before runner on missing, malformed, oversized or mismatched PNG bounds', async()=>fixture(async dir=>{
  let calls=0; const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async()=>{calls++;return reply();}});
  const invalid:Array<(i:PlannerInput)=>void>=[
    i=>{delete i.observation.screen;},
    i=>{const h=Buffer.from(png().subarray(16,29));h[9]=3;i.observation.screen!.pngBase64=Buffer.concat([png().subarray(0,8),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(6))),chunk('IEND',Buffer.alloc(0))]).toString('base64');},
    i=>{const b=png();i.observation.screen!.pngBase64=Buffer.concat([b.subarray(0,33),chunk('PLTE',Buffer.alloc(1)),b.subarray(33)]).toString('base64');},
    i=>{i.observation.screen!.pngBase64='not base64';},
    i=>{i.observation.screen!.pngBase64=Buffer.alloc(4*1024*1024+1).toString('base64');},
    i=>{i.observation.screen!.width=3;},
    i=>{i.observation.screen!.height=0;},
    i=>{i.observation.screen!.viewportWidth=NaN;},
    i=>{i.observation.screen!.frameId='';},
    i=>{i.observation.screen!.pngBase64=png().subarray(0,33).toString('base64');},
    i=>{const b=png();b[45]^=1;i.observation.screen!.pngBase64=b.toString('base64');},
    i=>{i.observation.screen!.pngBase64=png(1281,1).toString('base64');i.observation.screen!.width=1281;i.observation.screen!.height=1;},
  ];
  for(const mutate of invalid) {const i=input();mutate(i);await assert.rejects(planner.next(i),/screen|PNG|image|frame|bounds/i);}
  assert.equal(calls,0);assert.deepEqual(await readdir(dir),[]);
}));

test('base64 is excluded from every textual channel and DOM-only mode never attaches a screen', async()=>fixture(async dir=>{
  const i=input();const encoded=i.observation.screen!.pngBase64;
  i.history=[{id:'h',at:'x',kind:'observation',text:JSON.stringify({screen:i.observation.screen})}];i.prompt+=' '+encoded;i.observation.text+=' data:image/png;base64,'+encoded;
  i.settings={...DEFAULT_SETTINGS,memoryEnabled:true};i.memory=[{id:'m',text:encoded,createdAt:'x'}];
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async request=>{assert(!request.input.includes(encoded));assert(!request.input.includes('pngBase64'));if(!i.computerUse){assert(!request.args.includes('--image'));assert(!request.input.includes('frame-1'));}return reply();}});
  await planner.next(i);i.computerUse=false;await planner.next(i);
}));

test('strict parser and request schema support bounded frame-bound computer actions only', async()=>fixture(async dir=>{
  const actions=[{type:'computer_click',x:1,y:0,frameId:'frame-1'},{type:'computer_type',value:'hello',frameId:'frame-1'},{type:'computer_key',key:'Enter',frameId:'frame-1'}];
  for(const action of actions) assert.deepEqual(parsePlanOutput(JSON.stringify({thought:'x',action})).action,action);
  for(const action of [
    {...actions[0],x:-1},{...actions[0],x:1.5},{...actions[0],x:1280},{...actions[0],y:900},{...actions[0],frameId:''},
    {...actions[1],value:'x'.repeat(4001)},{...actions[2],key:'Meta'},{...actions[2],key:'Control+C'},{...actions[0],url:'https://example.com/'},
    {type:'finish',text:'done',x:1},{...actions[0],extra:true},
  ]) assert.throws(()=>parsePlanOutput(JSON.stringify({thought:'x',action})));
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async request=>{
    const schema=JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema')+1]!,'utf8'));
    assert.equal(schema.properties.action.additionalProperties,false);
    for(const name of ['computer_click','computer_type','computer_key']) assert(schema.properties.action.properties.type.enum.includes(name));
    for(const name of ['x','y','frameId','key']) assert(schema.properties.action.required.includes(name));
    return reply(actions[0]);
  }}); assert.deepEqual((await planner.next(input())).action,actions[0]);
}));

test('planner rejects computer plans without consent or matching attached frame and image coordinates', async()=>fixture(async dir=>{
  for (const [computerUse,action] of [[false,{type:'computer_key',key:'Enter',frameId:'frame-1'}],[true,{type:'computer_click',x:2,y:0,frameId:'frame-1'}],[true,{type:'computer_type',value:'hello',frameId:'stale'}]] as const) {
    const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async()=>reply(action)});const i=input();i.computerUse=computerUse;await assert.rejects(planner.next(i),/computer|frame|bounds|consent/i);assert.deepEqual(await readdir(dir),[]);
  }
}));

async function until(check:()=>boolean) {for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition did not become true');}

test('FIFO process gate limits runner entry and removes canceled queued requests with honest activity counts', async()=>fixture(async dir=>{
  const activities:ProviderActivity[]=[];const entered:string[]=[];const release=new Map<string,()=>void>();
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,maxProcesses:1,onActivity:a=>activities.push({...a}),runner:async request=>{const id=JSON.parse(request.input.split('UNTRUSTED INPUT JSON:\n')[1]!).request;entered.push(id);await new Promise<void>(resolve=>release.set(id,resolve));return reply();}});
  const start=(id:string,signal?:AbortSignal)=>{const i=input(signal);i.prompt=id;return planner.next(i);};
  const first=start('first');await until(()=>entered.length===1);
  const canceled=new AbortController();const second=start('second',canceled.signal);const rejected=assert.rejects(second,/취소|cancel/i);await until(()=>activities.at(-1)?.waiting===1);
  const third=start('third');await until(()=>activities.at(-1)?.waiting===2);canceled.abort();await rejected;assert.equal(activities.at(-1)?.waiting,1);assert.deepEqual(entered,['first']);
  release.get('first')!();await first;await until(()=>entered.length===2);assert.deepEqual(entered,['first','third']);release.get('third')!();await third;
  assert.deepEqual(activities.at(-1),{running:0,waiting:0,limit:1});assert(activities.every(a=>a.running<=1&&a.waiting>=0&&a.limit===1));assert.deepEqual(await readdir(dir),[]);
}));

test('process limit rejects values outside integer 1..8 instead of hanging or oversubscribing', ()=>{
  for (const maxProcesses of [0,9,-1,1.5,NaN,Infinity]) assert.throws(()=>new CodexPlanner({binary:'injected-only',workDir:'unused',maxProcesses}),/1.*8|limit|Processes/);
});

test('shared schema is deeply immutable so one consumer cannot corrupt concurrent requests',()=>{
  assert(Object.isFrozen(PLAN_SCHEMA));assert(Object.isFrozen(PLAN_SCHEMA.properties.action.properties.type.enum));assert.throws(()=>PLAN_SCHEMA.properties.action.properties.type.enum.push('shell'));
});

test('default gate admits eight injected runners with isolated images/schema and no cross-cleanup',async()=>fixture(async dir=>{
  const activities:ProviderActivity[]=[];const files:string[]=[];let entered=0;let unblock!:()=>void;const barrier=new Promise<void>(resolve=>{unblock=resolve;});
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,onActivity:a=>activities.push({...a}),runner:async request=>{
    const image=request.args[request.args.indexOf('--image')+1]!, schema=request.args[request.args.indexOf('--output-schema')+1]!;files.push(image,schema);entered++;await barrier;assert.deepEqual(await readFile(image),png());assert.equal(JSON.parse(await readFile(schema,'utf8')).additionalProperties,false);return reply();
  }});
  const tasks=Array.from({length:8},()=>planner.next(input()));try{await until(()=>entered===8);assert.equal(activities.at(-1)?.running,8);assert.equal(new Set(files).size,16);}finally{unblock();}await Promise.all(tasks);assert.deepEqual(await readdir(dir),[]);assert.deepEqual(activities.at(-1),{running:0,waiting:0,limit:8});
}));

test('aborting subprocess retains its runner reservation until close and escalates a stuck process',async()=>{
  assert.equal(typeof provider.createPlannerProcessRunner,'function');
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:(signal:string)=>{kills.push(signal);return true;}});const kills:string[]=[];
  const run=provider.createPlannerProcessRunner({spawn: (()=>child) as unknown as typeof spawn,killGraceMs:5});
  const abort=new AbortController();let settled=false;const pending=run({binary:'never-executed',args:[],cwd:'unused',input:'fixture',signal:abort.signal});const rejected=assert.rejects(pending,/취소/).then(()=>{settled=true;});
  abort.abort();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(settled,false);assert.deepEqual(kills,['SIGTERM','SIGKILL']);child.emit('close',null);await rejected;
});

test('runner failure and native computer tool activity fail closed and clean only request files',async()=>fixture(async dir=>{
  for(const runner of [async()=>{throw new Error('fixture failure');},async()=>JSON.stringify({type:'item.completed',item:{type:'computer_use',x:1,y:1}})+'\n'+reply(),async()=>'{invalid json']){
    const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner});await assert.rejects(planner.next(input()));assert.deepEqual(await readdir(dir),[]);
  }
}));

test('active cancellation does not free a slot or image before runner settlement or cancel another job',async()=>fixture(async dir=>{
  const activities:ProviderActivity[]=[];const entered:string[]=[];let firstImage='';let stop!:()=>void;
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,maxProcesses:1,onActivity:a=>activities.push({...a}),runner:async request=>{
    const id=JSON.parse(request.input.split('UNTRUSTED INPUT JSON:\n')[1]!).request;entered.push(id);
    if(id==='first'){firstImage=request.args[request.args.indexOf('--image')+1]!;await new Promise<void>((_resolve,reject)=>{stop=()=>reject(new Error('fixture canceled'));});}
    return reply();
  }});
  const abort=new AbortController();const i=input(abort.signal);i.prompt='first';const first=planner.next(i);const rejected=assert.rejects(first);await until(()=>entered.length===1);
  const j=input();j.prompt='second';const second=planner.next(j);await until(()=>activities.at(-1)?.waiting===1);abort.abort();await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(entered,['first']);assert.deepEqual(await readFile(firstImage),png());assert.equal(activities.at(-1)?.running,1);
  stop();await rejected;await second;assert.deepEqual(entered,['first','second']);assert.deepEqual(await readdir(dir),[]);assert.deepEqual(activities.at(-1),{running:0,waiting:0,limit:1});
}));

test('process runner bounds stdout and never includes stderr diagnostics in errors',async()=>{
  const kills:string[]=[];const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:(s:string)=>{kills.push(s);return true;}});
  const run=provider.createPlannerProcessRunner({spawn:(()=>child) as unknown as typeof spawn});
  const result=run({binary:'never-executed',args:[],cwd:'unused',input:'fixture',signal:new AbortController().signal});const rejected=assert.rejects(result,error=>error instanceof Error&&/출력 제한/.test(error.message)&&!error.message.includes('PRIVATE ACCOUNT'));
  child.stderr.write('PRIVATE ACCOUNT');child.stdout.write('x'.repeat(1_000_001));child.stdout.write('ignored'.repeat(100));assert.deepEqual(kills,['SIGTERM']);child.emit('close',1);await rejected;
});

test('strict JSONL rejects tool events outside item envelopes and bounded injected-runner overflow',async()=>fixture(async dir=>{
  for(const raw of [JSON.stringify({type:'tool.started',name:'computer_use'})+'\n'+reply(),JSON.stringify({unexpected:'untrusted event'})+'\n'+reply(),' '.repeat(1_000_001)+reply()]){
    const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async()=>raw});await assert.rejects(planner.next(input()));assert.deepEqual(await readdir(dir),[]);
  }
}));

test('a concurrent caller cannot swap frame metadata after its PNG attachment was prepared',async()=>fixture(async dir=>{
  const i=input();const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async()=>{i.observation.screen!.frameId='swapped';return reply({type:'computer_click',x:0,y:0,frameId:'swapped'});}});await assert.rejects(planner.next(i),/frame/i);
}));

test('computer request attaches actual PNG in a private request directory and removes it after completion', async()=>fixture(async dir=>{
  let imagePath=''; let requestDir='';
  const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async request=>{
    const index=request.args.indexOf('--image'); assert(index>=0,'actual image attachment missing'); imagePath=request.args[index+1]!; requestDir=dirname(imagePath);
    assert.deepEqual(await readFile(imagePath),png());
    assert.notEqual(requestDir,dir); assert.equal((await stat(requestDir)).mode&0o777,0o700); assert.equal((await stat(imagePath)).mode&0o777,0o600);
    assert(!request.input.includes('pngBase64')); assert(!request.input.includes(png().toString('base64')));
    assert(request.args.includes('computer_use')); assert(!request.args.some(arg=>arg.startsWith('--dangerously')));
    return reply();
  }});
  assert.equal((await planner.next(input())).action.type,'finish');
  await assert.rejects(stat(imagePath),{code:'ENOENT'}); await assert.rejects(stat(requestDir),{code:'ENOENT'}); assert.deepEqual(await readdir(dir),[]);
}));
