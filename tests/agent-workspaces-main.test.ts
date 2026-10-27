import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentWorkspaces,projectWorkspace} from '../src/desktop/agent-workspaces';
import type {BrowserState,Job,Observation,TaskInput} from '../src/contract';
import {parseCommand,assertSurfaceCommand} from '../src/desktop/security';

test('agent starts require explicit page and reject renderer grants',()=>{
 assert.deepEqual(parseCommand({type:'agents.start',tabId:'page',prompt:'read'}),{type:'agents.start',tabId:'page',prompt:'read'});
 assert.throws(()=>parseCommand({type:'agents.start',prompt:'read'}));
 assert.throws(()=>parseCommand({type:'agents.start',tabId:'page',prompt:'read',agentScope:{}}));
 assert.throws(()=>parseCommand({type:'agents.start',tabId:'page',prompt:'read',computerUse:true}));
 assert.deepEqual(parseCommand({type:'agents.show'}),{type:'agents.show'});
});

test('visible primary request fields survive parsing and stale consent is rejected before handoff',async()=>{
 const raw={type:'agents.start',tabId:'a',prompt:'Read',expectedUrl:'https://example.com/a',expectedRevision:4,computerUse:false,shareScreen:true};
 const parsed=parseCommand(raw);assert(parsed.type==='agents.start');assert.deepEqual(parsed,raw);
 const fresh=fixture();await fresh.workspaces.start(parsed);assert.equal(fresh.sent.length,1);
 const stale=fixture();stale.state.tabs[0].revision=5;await assert.rejects(stale.workspaces.start(parsed),/문서/);assert.equal(stale.sent.length,0);assert.deepEqual(stale.order,[]);
 const moved=fixture();moved.state.tabs[0].url='https://example.com/changed';await assert.rejects(moved.workspaces.start(parsed),/문서/);assert.equal(moved.sent.length,0);
 for(const patch of [{expectedRevision:undefined},{expectedUrl:undefined},{expectedRevision:-1},{expectedRevision:1.5}])assert.throws(()=>parseCommand({...raw,...patch}));
});

test('agent renderer has a narrow command allowlist',()=>{
 assert.doesNotThrow(()=>assertSurfaceCommand('agent',{type:'layout.set',sidebarWidth:0,top:100,left:0,bottom:0,hideBrowser:false}));
 assert.doesNotThrow(()=>assertSurfaceCommand('agent',{type:'tab.takeControl',profileId:'p',tabId:'t'}));
 for(const type of ['tab.new','tab.navigate','profile.activate','settings.update','agents.start','job.start','jobs.startSections'])assert.throws(()=>assertSurfaceCommand('agent',{type} as Parameters<typeof assertSurfaceCommand>[1]));
});

function fixture(){
 const state:BrowserState={profiles:[{id:'p',name:'Default',incognito:false}],activeProfileId:'p',activeTabId:'a',paneTabIds:['a','b'],tabs:['a','b'].map(id=>({id,profileId:'p',title:id,url:'https://example.com/'+id,revision:4,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',lifecycle:'live'}))};
 const sent:TaskInput[]=[],returned:string[]=[],observed:string[]=[],order:string[]=[],jobs:Job[]=[];
 let ready=true,afterDocument='doc',block:Promise<void>|undefined,settleB:Promise<void>|undefined,failA=false;
 const workspaces=new AgentWorkspaces({readState:()=>state,readJobs:()=>jobs,ready:()=>ready,starting:()=>false,ensureHost:async()=>({}),now:()=>1000,agentSlots:()=>2,settle:async context=>{order.push('settle:'+context.tabId);if(context.tabId==='b')await settleB;},
  observe:async context=>{observed.push(context.tabId);const tab=state.tabs.find(t=>t.id===context.tabId)!;return{...context,revision:tab.revision,url:tab.url,title:'',text:'',elements:[],capturedAt:'',readingViewport:{documentId:tab.agentAreaId?afterDocument:'doc',scrollY:0,height:100,scrollHeight:100,text:''}} satisfies Observation;},
  handoff:async context=>{order.push('handoff:'+context.tabId);const tab=state.tabs.find(t=>t.id===context.tabId)!;tab.agentAreaId='area-'+tab.id;tab.revision++;state.paneTabIds=state.paneTabIds!.filter(id=>id!==tab.id);return{areaId:tab.agentAreaId,context};},
  returnPage:async context=>{returned.push(context.tabId);delete state.tabs.find(t=>t.id===context.tabId)!.agentAreaId;},
  send:input=>{order.push('send:'+input.tabId);if(failA&&input.tabId==='a')throw new Error('A bind revoked');sent.push(input);return input.tabId==='a'?block??Promise.resolve():Promise.resolve();}
 });
 return{state,sent,returned,observed,order,jobs,workspaces,setReady:(value:boolean)=>{ready=value;},changeDocument:()=>{afterDocument='changed';},blockA:(value:Promise<void>)=>{block=value;},holdSettleB:(value:Promise<void>)=>{settleB=value;},failA:()=>{failA=true;}};
}

test('handoff binds fresh isolated document and main-owned bounded origin grant',async()=>{
 const f=fixture();await f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read'});
 assert.equal(f.sent[0].initialDocument?.revision,5);
 assert.deepEqual(f.sent[0].agentScope,{areaId:'area-a',origin:'https://example.com',expiresAt:new Date(1801000).toISOString()});
 assert.deepEqual(f.observed,['a','a']);
 assert.equal(projectWorkspace(f.state,'browser').tabs.some(t=>t.id==='a'),false);
 assert.equal(projectWorkspace(f.state,'agent').tabs[0].id,'a');
});

test('handoff rejects changed isolated document and returns the same page',async()=>{
 const f=fixture();f.changeDocument();await assert.rejects(f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read'}));
 assert.equal(f.sent.length,0);assert.deepEqual(f.returned,['a']);
});

test('provider readiness, duplicate pending starts and screen consent are enforced',async()=>{
 const f=fixture();f.setReady(false);await assert.rejects(f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read'}));
 f.setReady(true);await assert.rejects(f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read',computerUse:true}));
 let release!:()=>void;f.blockA(new Promise<void>(resolve=>{release=resolve;}));
 const first=f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read'});
 await assert.rejects(f.workspaces.start({type:'agents.start',tabId:'a',prompt:'Read'}));release();await first;
});

test('section B starts while A is awaiting worker acknowledgement',async()=>{
 const f=fixture();let release!:()=>void;f.blockA(new Promise<void>(resolve=>{release=resolve;}));
 const starting=f.workspaces.startSections({type:'agents.startSections',consent:true,tasks:f.state.tabs.map(t=>({tabId:t.id,expectedRevision:4,expectedUrl:t.url,prompt:'Read'}))});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(f.sent.map(t=>t.tabId).sort(),['a','b']);release();await starting;
});

test('automatic section delegation defaults to DOM rather than silently enabling coordinate control',async()=>{
 const f=fixture();await f.workspaces.startSections({type:'agents.startSections',consent:true,tasks:f.state.tabs.map(t=>({tabId:t.id,expectedRevision:4,expectedUrl:t.url,prompt:'Read'}))});
 assert.equal(f.sent.length,2);assert(f.sent.every(input=>input.computerUse===false&&input.shareScreen===true));
});

test('batch hands off every native page before settling documents or dispatching models',async()=>{
 const f=fixture();await f.workspaces.startSections({type:'agents.startSections',consent:true,tasks:f.state.tabs.map(t=>({tabId:t.id,expectedRevision:4,expectedUrl:t.url,prompt:'Read'}))});
 assert.ok(f.order.indexOf('handoff:b')<f.order.indexOf('send:a'));
 assert.ok(f.order.indexOf('handoff:b')<f.order.indexOf('settle:a'));
 assert.ok(f.order.indexOf('settle:a')<f.order.indexOf('send:a'));
});

test('expanding native grid with an active peer fails before moving the requested page',async()=>{
 const f=fixture();f.state.tabs[0].agentAreaId='retained-a';
 f.state.tabs.push({...f.state.tabs[1],id:'c',agentAreaId:'retained-c'});f.state.paneTabIds=['b'];
 f.jobs.push({id:'job-a',profileId:'p',tabId:'a',status:'running'} as Job);
 await assert.rejects(f.workspaces.start({type:'agents.start',tabId:'b',prompt:'Read'}),/확장/);
 assert.equal(f.order.some(item=>item.startsWith('handoff:')),false);
});

test('ready and exact page revision are rechecked at dispatch after peer setup completes',async()=>{
 const f=fixture();let release!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 // B holds only native setup; a user reclaim/edit of A must invalidate its grant.
 f.holdSettleB(barrier);
 const starting=f.workspaces.startSections({type:'agents.startSections',consent:true,tasks:f.state.tabs.map(t=>({tabId:t.id,expectedRevision:4,expectedUrl:t.url,prompt:'Read'}))});
 await new Promise<void>(resolve=>setImmediate(resolve));f.state.tabs[0].revision++;release();
 await assert.rejects(starting);assert.equal(f.sent.some(task=>task.tabId==='a'),false);assert.equal(f.sent.some(task=>task.tabId==='b'),true);
});

test('a synchronous epoch binding failure on A does not prevent B from starting',async()=>{
 const f=fixture();f.failA();await assert.rejects(f.workspaces.startSections({type:'agents.startSections',consent:true,tasks:f.state.tabs.map(t=>({tabId:t.id,expectedRevision:4,expectedUrl:t.url,prompt:'Read'}))}));
 assert.equal(f.sent.some(task=>task.tabId==='b'),true);
});
