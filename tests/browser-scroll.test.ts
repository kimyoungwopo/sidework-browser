import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as dom from '../src/desktop/browser-dom.ts';

function page(reduced = false, start = 0) {
  let now = 0, next = 0, y = start;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at:number; run:()=>void }>();
  const listeners = new Map<string, Set<(event:{isTrusted:boolean})=>void>>();
  const body = { childNodes:[], scrollHeight:2000, clientHeight:500, isConnected:true };
  const addEventListener = (name:string, run:(event:{isTrusted:boolean})=>void) => { if(!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name)!.add(run); };
  const removeEventListener = (name:string, run:(event:{isTrusted:boolean})=>void) => { listeners.get(name)?.delete(run); };
  const world = vm.createContext({
    document:{title:'Fixture',body,documentElement:body,scrollingElement:body,querySelectorAll:()=>[],addEventListener,removeEventListener},
    location:{href:'https://fixture.test/'},crypto:{randomUUID:()=> 'doc'},getComputedStyle:()=>({display:'block',visibility:'visible'}),
    MutationObserver:class { observe() {} takeRecords() {return [];} },
    performance:{now:()=>now},
    requestAnimationFrame:(run:FrameRequestCallback)=>{frames.set(++next,run);return next;},cancelAnimationFrame:(id:number)=>frames.delete(id),
    setTimeout:(run:()=>void,delay:number)=>{timers.set(++next,{at:now+delay,run});return next;},clearTimeout:(id:number)=>timers.delete(id),
    window:{innerWidth:1000,innerHeight:500,scrollX:0,get scrollY(){return y;},matchMedia:()=>({matches:reduced}),addEventListener,removeEventListener,
      scrollTo:({top}:{top:number})=>{y=Math.max(0,Math.min(1500,top));},scrollBy:({top}:{top:number})=>{y=Math.max(0,Math.min(1500,y+top));}},
  });
  const stamp = () => vm.runInContext(dom.observationScript(),world).stamp as string;
  return {world,stamp,get y(){return y;},frames,timers,listeners,
    tick:(time:number)=>{now=time;const pending=[...frames.values()];frames.clear();for(const run of pending) run(now);for(const [id,timer] of timers) if(timer.at<=now){timers.delete(id);timer.run();}},
    input:(name:string,trusted=true)=>{for(const run of [...listeners.get(name)??[]]) run({isTrusted:trusted});},
  };
}

test('instant scroll settlement acknowledges two frames before exposing a stable post-scroll revision',async()=>{
  const p=page();p.stamp();
  vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp()),p.world);
  let done=false;
  const pending=Promise.resolve(vm.runInContext(dom.scrollSettlementScript(),p.world)).then(()=>{done=true;});
  p.tick(16);p.input('scroll');await Promise.resolve();assert.equal(done,false);
  p.tick(32);await pending;
  const after=p.stamp();assert.equal(p.stamp(),after);assert.equal(p.frames.size,0);assert.equal(p.timers.size,0);
});

test('scroll settlement fails closed on replacement, navigation, trusted input and missing frames',async()=>{
  for(const reason of ['replacement','navigation','input','timeout']) {
    const p=page();
    const pending=Promise.resolve(vm.runInContext(dom.scrollSettlementScript(),p.world));
    const rejected=assert.rejects(pending,/document|interrupt|timed out/i);
    if(reason==='replacement')vm.runInContext('document.documentElement={}',p.world);
    else if(reason==='navigation')vm.runInContext('location.href="https://fixture.test/next"',p.world);
    else if(reason==='input')p.input('wheel');
    else p.frames.clear();
    p.tick(reason==='timeout'?1001:16);await rejected;
    assert.equal(p.frames.size,0);assert.equal(p.timers.size,0);
    for(const name of ['wheel','pointerdown','touchstart','keydown','pagehide'])assert.equal(p.listeners.get(name)?.size??0,0);
  }
});

test('ordinary instant scroll stays synchronous and stale smooth actions never move the page',()=>{
  const p=page();
  assert.equal(vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp()),p.world),undefined);
  assert.equal(p.y,600);assert.equal(p.frames.size,0);assert.equal(p.timers.size,0);
  const stale=p.stamp();vm.runInContext('document.title="Replaced title"',p.world);
  assert.throws(()=>vm.runInContext(dom.actionScript({type:'scroll',direction:'up'},stale,{smoothScroll:true}),p.world),/Stale/);
  assert.equal(p.y,600);
});

test('cancel-all removes only owned animation and old job IDs cannot stop a later job',async()=>{
  const p=page();
  const run=(jobId:string)=>Promise.resolve(vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp(),{smoothScroll:true,jobId}),p.world));
  const first=run('old');const rejected=assert.rejects(first,/cancel/);
  vm.runInContext(dom.cancelScrollScript(),p.world);await rejected;
  const second=run('new');vm.runInContext(dom.cancelScrollScript('old'),p.world);
  p.tick(700);await second;assert.equal(p.y,600);
});

test('smooth motion fails closed and tears down on trusted input, replacement, timeout and unverifiable movement',async()=>{
  for(const reason of ['wheel','pointerdown','touchstart','keydown','pagehide','replacement','timeout','blocked']) {
    const p=page();
    const pending=Promise.resolve(vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp(),{smoothScroll:true}),p.world));
    const rejected=assert.rejects(pending,/interrupt|document|timeout|location/i);
    p.tick(100);p.input('wheel',false);assert(p.frames.size>0);
    if(reason==='replacement') vm.runInContext('document.documentElement = {}',p.world);
    else if(reason==='blocked') vm.runInContext('window.scrollTo=()=>{}',p.world);
    else if(reason==='timeout') p.frames.clear();
    else p.input(reason);
    p.tick(reason==='timeout'?2000:700);
    await rejected;
    const y=p.y;p.tick(3000);assert.equal(p.y,y);assert.equal(p.frames.size,0);assert.equal(p.timers.size,0);
    for(const name of ['wheel','pointerdown','touchstart','keydown','pagehide']) assert.equal(p.listeners.get(name)?.size??0,0);
  }
});

test('reduced motion and clamped boundaries complete immediately without animation resources',async()=>{
  for(const p of [page(true),page(false,1500)]) {
    const pending=vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp(),{smoothScroll:true}),p.world);
    assert.equal(p.frames.size,0);await pending;assert.equal(p.y,p.y===1500?1500:600);
  }
});

test('job scoped cancellation stops motion in only its isolated world and cleans owned resources',async()=>{
  const a=page(), b=page();
  const run=(p:ReturnType<typeof page>,jobId:string)=>Promise.resolve(vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp(),{smoothScroll:true,jobId}),p.world));
  const first=run(a,'one'), second=run(b,'two');
  const rejected=assert.rejects(first,/cancel/i);
  a.tick(100);b.tick(100);
  assert.equal(typeof dom.cancelScrollScript,'function');
  vm.runInContext(dom.cancelScrollScript('other'),a.world);
  assert(a.frames.size>0);
  vm.runInContext(dom.cancelScrollScript('one'),a.world);
  const stopped=a.y;a.tick(700);assert.equal(a.y,stopped);
  await rejected;assert.equal(a.frames.size,0);assert.equal(a.timers.size,0);
  b.tick(700);await second;assert.equal(b.y,600);
});

 test('smooth scroll returns a pending promise and moves continuously for 700ms before verified completion',async()=>{
  const p=page();let done=false;
  const pending=vm.runInContext(dom.actionScript({type:'scroll',direction:'down'},p.stamp(),{smoothScroll:true,jobId:'one'}),p.world);
  assert.equal(typeof pending?.then,'function');
  const result=Promise.resolve(pending).then(()=>{done=true;});
  p.tick(350);await Promise.resolve();assert(p.y>0 && p.y<600);assert.equal(done,false);
  p.tick(699);await Promise.resolve();assert.equal(done,false);
  p.tick(700);await result;assert.equal(p.y,600);assert.equal(p.frames.size,0);assert.equal(p.timers.size,0);
 });
