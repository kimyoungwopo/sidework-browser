import type {AppCommand,BrowserContext,BrowserState,Job,Observation,SectionTask,TaskInput} from '../contract';
import {safePageUrl} from './codex-desktop';
import {taskContext} from './tasks';

type Start=Extract<AppCommand,{type:'agents.start'}>;
interface WorkspacePorts<Host>{
 readState():BrowserState;
 readJobs():readonly Job[];
 ready():boolean;
 starting(context:BrowserContext):boolean;
 agentSlots():number;
 ensureHost():Promise<Host>;
 observe(context:BrowserContext):Promise<Observation>;
 /** Main-local native capture/compositor barrier; never forwards pixels to worker. */
 settle(context:BrowserContext):Promise<void>;
 handoff(context:BrowserContext,host:Host):Promise<{areaId:string;context:BrowserContext}>;
 returnPage(context:BrowserContext):Promise<void>;
 send(input:TaskInput):Promise<unknown>;
 now?:()=>number;
}
interface Initial {context:BrowserContext;key:string;url:string;revision:number;input:Start}
const active=(job:Job)=>['queued','running','awaiting_approval'].includes(job.status);
const keyOf=(context:BrowserContext)=>`${context.profileId}:${context.tabId}`;

/** Projection only; the controller retains all native pages and their identities. */
export function projectWorkspace(state:BrowserState,surface:'browser'|'agent'):BrowserState{
 const tabs=state.tabs.filter(tab=>surface==='agent'?!!tab.agentAreaId:!tab.agentAreaId);
 const ids=new Set(tabs.map(tab=>tab.id));
 const panes=(surface==='agent'?state.agentPaneTabIds??tabs.map(tab=>tab.id):state.paneTabIds??[]).filter(id=>ids.has(id));
 return{...state,tabs,paneTabIds:panes,activeTabId:state.activeTabId&&ids.has(state.activeTabId)?state.activeTabId:panes[0]??null};
}

/** Native setup finishes first; model loops and ACKs never wait for a peer. */
export class AgentWorkspaces<Host>{
 private readonly pending=new Set<string>();
 constructor(private readonly ports:WorkspacePorts<Host>){}
 get pendingCount():number{return this.pending.size;}
 isPending(context:BrowserContext):boolean{return this.pending.has(keyOf(context));}
 private validate(input:Start,expected?:SectionTask):Initial{
  const state=this.ports.readState(),jobs=this.ports.readJobs();
  if(!this.ports.ready())throw new Error('Codex 연결을 먼저 준비하세요.');
  const context=taskContext(state,input.tabId,!!input.computerUse,input.shareScreen===true);
  const tab=state.tabs.find(tab=>tab.id===context.tabId&&tab.profileId===context.profileId)!;
  const key=keyOf(context);
  if(!input.prompt.trim()||input.prompt.length>8000||tab.agentAreaId||tab.lifecycle!=='live'||tab.isLoading||this.pending.has(key)||this.ports.starting(context)||jobs.some(job=>active(job)&&job.profileId===context.profileId&&job.tabId===context.tabId))throw new Error('현재 준비된 사용자 페이지를 중복 없이 선택하세요.');
  if((expected&&(tab.url!==expected.expectedUrl||tab.revision!==expected.expectedRevision))||((input.expectedUrl!==undefined||input.expectedRevision!==undefined)&&(tab.url!==input.expectedUrl||tab.revision!==input.expectedRevision)))throw new Error('대상 문서가 변경되었습니다. 다시 동의하세요.');
  safePageUrl(tab.url);
  return{context,key,url:tab.url,revision:tab.revision,input};
 }
 private assertCapacity(initials:Initial[]):void{
  const state=this.ports.readState(),jobs=this.ports.readJobs().filter(active);
  const owned=new Set([...this.pending,...state.tabs.filter(tab=>tab.agentAreaId).map(tab=>keyOf({profileId:tab.profileId,tabId:tab.id})),...initials.map(initial=>initial.key)]);
  const work=new Set([...this.pending,...jobs.map(keyOf),...initials.map(initial=>initial.key)]);
  if(owned.size>8||work.size>8)throw new Error('에이전트 작업은 최대 8개입니다.');
  if(owned.size>this.ports.agentSlots()&&(jobs.length||this.pending.size))throw new Error('실행 중인 작업을 중지한 뒤 에이전트 화면을 확장하세요. 작업 중인 화면 크기는 변경하지 않습니다.');
 }
 private assertUserDocument(initial:Initial,before:Observation):void{
  const state=this.ports.readState(),tab=state.tabs.find(tab=>tab.id===initial.context.tabId&&tab.profileId===initial.context.profileId);
  if(!this.ports.ready()||this.ports.starting(initial.context)||state.activeProfileId!==initial.context.profileId||!tab||tab.agentAreaId||tab.isLoading||!state.paneTabIds?.includes(tab.id)||tab.url!==initial.url||tab.revision!==before.revision||before.url!==initial.url||before.revision!==initial.revision||!before.readingViewport?.documentId||this.ports.readJobs().some(job=>active(job)&&job.profileId===initial.context.profileId&&job.tabId===initial.context.tabId))throw new Error('전달 전에 문서가 변경되었습니다. 다시 시작하세요.');
 }
 private async prepare(initial:Initial,before:Observation,areaId:string):Promise<TaskInput>{
  await this.ports.settle(initial.context);
  const after=await this.ports.observe(initial.context);
  const state=this.ports.readState(),retained=state.tabs.find(tab=>tab.id===initial.context.tabId&&tab.profileId===initial.context.profileId);
  if(!this.ports.ready()||state.activeProfileId!==initial.context.profileId||!areaId||retained?.agentAreaId!==areaId||retained.isLoading||retained.url!==initial.url||retained.revision!==after.revision||after.url!==before.url||after.revision<=before.revision||after.readingViewport?.documentId!==before.readingViewport?.documentId)throw new Error('전달 후 문서가 변경되었습니다. 다시 시작하세요.');
  return{prompt:initial.input.prompt,...initial.context,computerUse:initial.input.computerUse===true,shareScreen:initial.input.shareScreen===true,initialDocument:{url:after.url,revision:after.revision},agentScope:{areaId,origin:new URL(after.url).origin,expiresAt:new Date((this.ports.now?.()??Date.now())+30*60*1000).toISOString()}};
 }
 private async run(initials:Initial[]):Promise<void>{
  this.assertCapacity(initials);initials.forEach(initial=>this.pending.add(initial.key));
  const moved:Initial[]=[];
  try{
   const host=await this.ports.ensureHost();
   const before=await Promise.all(initials.map(initial=>this.ports.observe(initial.context)));
   const areas:string[]=[];
   try{
    for(const [index,initial] of initials.entries()){
     this.assertUserDocument(initial,before[index]);
     const handoff=await this.ports.handoff(initial.context,host);moved.push(initial);
     if(handoff.context.tabId!==initial.context.tabId||handoff.context.profileId!==initial.context.profileId||!handoff.areaId)throw new Error('전달 대상이 변경되었습니다.');
     areas.push(handoff.areaId);
    }
   }catch(error){await Promise.allSettled(moved.map(initial=>this.ports.returnPage(initial.context)));throw error;}
   // Native grid growth must finish before capturing any final document or
   // starting a model. This is setup, never a planner/approval rendezvous.
   const prepared=await Promise.allSettled(initials.map(async(initial,index)=>{
    try{return await this.prepare(initial,before[index],areas[index]);}
    catch(error){await this.ports.returnPage(initial.context);throw error;}
   }));
   const sent=await Promise.allSettled(prepared.map(async(result,index)=>{
    if(result.status==='rejected')return Promise.reject(result.reason);
    // command() synchronously stamps the current main-owned epoch. A timeout
    // may already represent a running job: retain its same visible native page.
    const task=result.value,state=this.ports.readState(),tab=state.tabs.find(tab=>tab.id===task.tabId&&tab.profileId===task.profileId);
    if(!this.ports.ready()||state.activeProfileId!==task.profileId||!tab||tab.isLoading||tab.agentAreaId!==task.agentScope?.areaId||tab.url!==task.initialDocument?.url||tab.revision!==task.initialDocument?.revision)return Promise.reject(new Error('시작 전에 전달한 문서가 변경되었습니다. 직접 제어로 돌려받아 다시 시작하세요.'));
    return this.ports.send(task).finally(()=>this.pending.delete(initials[index].key));
   }));
   const failed=sent.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }finally{initials.forEach(initial=>this.pending.delete(initial.key));}
 }
 async start(input:Start):Promise<void>{await this.run([this.validate(input)]);}
 async startSections(input:Extract<AppCommand,{type:'agents.startSections'}>):Promise<void>{
  if(input.consent!==true||input.tasks.length<1||input.tasks.length>8||new Set(input.tasks.map(task=>task.tabId)).size!==input.tasks.length)throw new Error('작업 화면과 동의를 확인하세요.');
  const initials=input.tasks.map(task=>this.validate({type:'agents.start',tabId:task.tabId,prompt:task.prompt,computerUse:false,shareScreen:true},task));
  await this.run(initials);
 }
}
