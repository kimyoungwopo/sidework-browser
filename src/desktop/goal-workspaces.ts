import {randomUUID} from 'node:crypto';
import type {AgentScope,BrowserContext,BrowserState,Job,Observation,TaskInput} from '../contract';
import type {GoalPlan,GoalPlanTask,GoalTask} from '../goal-contract';
import {assertPublicGoalUrl,goalScopeAllows} from '../goal-navigation';
import {validateAgentScope} from '../core/validation';

interface GoalPorts<Host>{
 readState():BrowserState;
 readJobs():readonly Job[];
 ready():boolean;
 agentSlots():number;
 ensureHost():Promise<Host>;
 plan(goalId:string,prompt:string):Promise<unknown>;
 cancelPlan(goalId:string):Promise<void>;
 createPage(input:{profileId:string;goalId:string;url:string;host:Host}):Promise<{areaId:string;context:BrowserContext}>;
 settle(context:BrowserContext):Promise<void>;
 observe(context:BrowserContext):Promise<Observation>;
 send(input:TaskInput):Promise<unknown>;
 cancelJob(id:string):Promise<void>;
 onChange():void;
 save?(goals:GoalTask[]):Promise<void>;
 now?:()=>number;
}
interface Grant {goalId:string;childId:string;context:BrowserContext;scope:AgentScope;prompt:string;jobId:string|null}
const active=(status:string)=>['queued','running','awaiting_approval','allocating'].includes(status);
const terminalGoal=(status:string)=>['completed','partial','failed','cancelled','interrupted'].includes(status);
function record(raw:unknown,keys:string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||keys.some(k=>!Object.hasOwn(raw,k)))throw new Error('작업 계획의 필드가 잘못되었습니다.');
 return raw as Record<string,unknown>;
}
function text(raw:unknown,max:number):string{if(typeof raw!=='string'||!raw.trim()||raw.length>max)throw new Error('작업 계획의 텍스트가 잘못되었습니다.');return raw;}
/** Revalidate the utility-worker result at the main allocation boundary. */
function planValue(raw:unknown):GoalPlan{
 const value=record(raw,['title','tasks']);
 if(!Array.isArray(value.tasks)||value.tasks.length<1||value.tasks.length>4)throw new Error('하위 작업은 1~4개입니다.');
 const tasks:GoalPlanTask[]=value.tasks.map(raw=>{
  const item=record(raw,['title','prompt','url','allowedOrigins','blocker']);
  const title=text(item.title,120),prompt=text(item.prompt,8000);
  if(!Array.isArray(item.allowedOrigins)||item.allowedOrigins.length>8)throw new Error('작업 사이트 범위가 잘못되었습니다.');
  if(item.url===null){if(item.allowedOrigins.length)throw new Error('실행 불가 작업에는 사이트 권한을 주지 않습니다.');return{title,prompt,url:null,allowedOrigins:[],blocker:text(item.blocker,1000)};}
  const url=text(item.url,4096),parsed=assertPublicGoalUrl(url);
  if(item.blocker!==null||item.allowedOrigins.length<1||new Set(item.allowedOrigins).size!==item.allowedOrigins.length||!item.allowedOrigins.includes(parsed.origin))throw new Error('작업 시작 주소와 범위가 일치하지 않습니다.');
  const allowedOrigins=item.allowedOrigins.map(value=>{const raw=text(value,4096);if(assertPublicGoalUrl(raw).origin!==raw)throw new Error('정확한 공개 사이트 origin만 허용합니다.');return raw;});
  return{title,prompt,url,allowedOrigins,blocker:null};
 });
 if(new Set(tasks.map(task=>task.title)).size!==tasks.length||new Set(tasks.map(task=>task.prompt)).size!==tasks.length)throw new Error('중복 작업을 에이전트 분업으로 만들지 않습니다.');
 return{title:text(value.title,120),tasks};
}

/** Goal-first orchestration. Native setup is bounded; running peers share no planner barrier. */
export class GoalWorkspaces<Host>{
 private goals:GoalTask[]=[];
 private readonly launches=new Map<string,Promise<void>>();
 private readonly revoked=new Set<string>();
 private readonly grants=new Map<string,Grant>();
 private publications:Promise<void>=Promise.resolve();
 private storageFailed=false;
 constructor(private readonly ports:GoalPorts<Host>){}
 get pendingCount():number{return this.launches.size;}
 get activeCount():number{return this.goals.filter(goal=>!terminalGoal(goal.status)).length;}
 getState(profileId?:string):GoalTask[]{return structuredClone(this.goals.filter(goal=>profileId===undefined||goal.profileId===profileId));}
 private stamp():string{return new Date(this.ports.now?.()??Date.now()).toISOString();}
 private async publish():Promise<void>{
  const snapshot=this.getState();
  const publication=this.publications.then(async()=>{
   if(this.storageFailed)throw new Error('목표 작업 저장소를 확인할 수 없습니다.');
   await this.ports.save?.(snapshot);this.ports.onChange();
  });
  this.publications=publication.catch(()=>undefined);
  try{await publication;}catch{
   this.storageFailed=true;
   for(const goal of this.goals)if(!terminalGoal(goal.status)){this.revoked.add(goal.id);goal.status='failed';goal.error='목표 작업 저장에 실패하여 실행 권한을 회수했습니다.';}
   this.ports.onChange();
   void Promise.allSettled(this.ports.readJobs().filter(job=>job.agentScope?.goalId&&this.revoked.has(job.agentScope.goalId)&&active(job.status)).map(job=>this.ports.cancelJob(job.id)));
   throw new Error('목표 작업 저장에 실패했습니다.');
  }
 }
 private check(goal:GoalTask):void{
  if(this.storageFailed||this.revoked.has(goal.id)||!this.ports.ready()||this.ports.readState().activeProfileId!==goal.profileId)throw new Error('목표 작업 실행 권한이 중단되었습니다.');
 }
 async start(prompt:string):Promise<string>{
  if(this.storageFailed||!this.ports.ready())throw new Error('Codex 연결을 먼저 준비하세요.');
  text(prompt,8000);
  const state=this.ports.readState(),profile=state.profiles.find(profile=>profile.id===state.activeProfileId);
  if(!profile||profile.incognito)throw new Error('목표 작업은 일반 프로필에서 시작하세요. 작업 기록은 로컬에 저장됩니다.');
  if(this.launches.size>=2)throw new Error('이미 두 요청의 작업 계획·페이지 준비가 진행 중입니다.');
  if(state.tabs.filter(tab=>tab.agentAreaId).length>=8)throw new Error('에이전트 페이지는 최대 8개입니다. 완료한 페이지를 직접 제어로 돌려받으세요.');
  const goal:GoalTask={id:randomUUID(),profileId:profile.id,title:prompt.slice(0,80),prompt,status:'planning',children:[],createdAt:this.stamp(),updatedAt:this.stamp(),error:null};
  this.goals.unshift(goal);
  if(this.goals.length>100){let last=-1;this.goals.forEach((item,index)=>{if(terminalGoal(item.status))last=index;});if(last>=0)this.goals.splice(last,1);}
  await this.publish();
  const launch=Promise.resolve().then(()=>this.prepare(goal)).finally(()=>this.launches.delete(goal.id));
  this.launches.set(goal.id,launch);
  return goal.id;
 }
 async drainPreparations():Promise<void>{await Promise.allSettled([...this.launches.values()]);}
 private summarize(goal:GoalTask):void{
  if(this.revoked.has(goal.id)||goal.status==='planning')return;
  const children=goal.children;
  if(children.some(child=>active(child.status)))goal.status=children.some(child=>child.status==='running'||child.status==='queued'||child.status==='allocating')?'running':'awaiting_approval';
  else if(children.length&&children.every(child=>child.status==='completed'))goal.status='completed';
  else goal.status=children.some(child=>child.status==='completed')?'partial':'failed';
  goal.updatedAt=this.stamp();
 }
 private async prepare(goal:GoalTask):Promise<void>{
  try{
   this.check(goal);
   const plan=planValue(await this.ports.plan(goal.id,goal.prompt));this.check(goal);
   goal.title=plan.title;goal.children=plan.tasks.map(task=>({id:randomUUID(),title:task.title,prompt:task.prompt,status:task.url?'allocating':'blocked',context:null,jobId:null,answer:null,error:task.blocker}));
   goal.status='running';goal.updatedAt=this.stamp();await this.publish();
   const executable=plan.tasks.flatMap((task,index)=>task.url?[{task,child:goal.children[index]!}]:[]);
   if(!executable.length){this.summarize(goal);await this.publish();return;}
   const state=this.ports.readState(),existing=state.tabs.filter(tab=>tab.agentAreaId).length;
   if(existing+executable.length>8||this.ports.readJobs().filter(job=>active(job.status)).length+executable.length>8)throw new Error('에이전트 작업·페이지 한도 8개를 넘습니다.');
   if(existing+executable.length>this.ports.agentSlots()&&this.ports.readJobs().some(job=>active(job.status)))throw new Error('실행 중인 다른 작업 화면을 변경하지 않습니다. 현재 작업이 끝난 뒤 새 요청을 시작하세요.');
   const host=await this.ports.ensureHost();this.check(goal);
   // Allocate every native view before observing or starting a model, so grid growth
   // cannot invalidate a running sibling's viewport. This is setup, not a run barrier.
   const allocations=await Promise.allSettled(executable.map(async item=>{
    this.check(goal);const page=await this.ports.createPage({profileId:goal.profileId,goalId:goal.id,url:item.task.url!,host});
    item.child.context=page.context;
    if(page.context.profileId!==goal.profileId||!page.areaId)throw new Error('목표 작업의 페이지 소유권이 일치하지 않습니다.');
    this.check(goal);return{...item,...page};
   }));
   await Promise.allSettled(allocations.map(async(result,index)=>{
    const child=executable[index]!.child;
    try{
     if(result.status==='rejected')throw result.reason;
     const {task,areaId,context}=result.value;
     this.check(goal);await this.ports.settle(context);this.check(goal);
     const observation=await this.ports.observe(context);this.check(goal);
     const page=this.ports.readState().tabs.find(tab=>tab.id===context.tabId&&tab.profileId===context.profileId);
     const scope:AgentScope={areaId,origin:assertPublicGoalUrl(task.url!).origin,expiresAt:new Date((this.ports.now?.()??Date.now())+30*60*1000).toISOString(),goalId:goal.id,allowedOrigins:[...task.allowedOrigins]};
     validateAgentScope(scope);
     if(!page||page.agentAreaId!==areaId||page.isLoading||page.url!==observation.url||page.revision!==observation.revision||observation.profileId!==context.profileId||observation.tabId!==context.tabId||!observation.readingViewport?.documentId||!goalScopeAllows(scope,observation.url))throw new Error('새 작업 페이지가 안정되지 않았거나 허용한 사이트를 벗어났습니다.');
     const prompt=task.prompt+'\n\n[앱 실행 범위] 이 작업에 허용된 사이트: '+task.allowedOrigins.join(', ')+'. 실제 관찰한 내용만 답하고 출처 URL을 함께 제시하세요. 파일·이미지 생성 또는 이미 수행하지 않은 행동을 완료했다고 주장하지 마세요.';
     const input:TaskInput={prompt,...context,computerUse:false,shareScreen:false,initialDocument:{url:observation.url,revision:observation.revision,documentId:observation.readingViewport.documentId},agentScope:scope};
     const grant:Grant={goalId:goal.id,childId:child.id,context,scope:structuredClone(scope),prompt,jobId:null};
     this.grants.set(context.tabId,grant);this.check(goal);
     const id=await this.ports.send(input);
     if(typeof id!=='string'||!id||id.length>100)throw new Error('작업 시작 응답을 확인하지 못했습니다. 페이지는 보존했습니다.');
     grant.jobId=id;child.jobId=id;
     if(this.revoked.has(goal.id)){await this.ports.cancelJob(id);child.status='cancelled';return;}
     const current=this.ports.readJobs().find(job=>job.id===id);
     child.status=current?.status??'running';child.answer=current?.answer??null;child.error=current?.error??null;
    }catch(error){child.status=this.revoked.has(goal.id)?'cancelled':'failed';child.error=error instanceof Error?error.message.slice(0,1000):'하위 작업을 시작하지 못했습니다.';}
    this.summarize(goal);await this.publish();
   }));
   this.summarize(goal);await this.publish();
  }catch(error){
   if(!this.revoked.has(goal.id)){goal.status='failed';goal.error=error instanceof Error?error.message.slice(0,1000):'목표 작업을 시작하지 못했습니다.';for(const child of goal.children)if(child.status==='allocating'){child.status='failed';child.error=goal.error;}}
   if(!this.storageFailed)await this.publish();
  }
 }
 private matching(job:Job):Grant|undefined{
  const grant=this.grants.get(job.tabId);
  if(!grant||grant.context.profileId!==job.profileId||grant.prompt!==job.prompt||JSON.stringify(grant.scope)!==JSON.stringify(job.agentScope)||(grant.jobId!==null&&grant.jobId!==job.id))return undefined;
  return grant;
 }
 /** Main ledger, independent of a worker snapshot's claimed capabilities. */
 assertJob(job:Job):void{
  if(!job.agentScope?.goalId)return;
  const grant=this.matching(job),goal=this.goals.find(goal=>goal.id===job.agentScope?.goalId);
  if(!grant||!goal||this.storageFailed||this.revoked.has(goal.id)||!['running','awaiting_approval'].includes(goal.status))throw new Error('목표 작업의 main 권한이 회수되었거나 일치하지 않습니다.');
 }
 reconcile(jobs:readonly Job[]):void{
  let changed=false;
  for(const goal of this.goals){
   if(this.revoked.has(goal.id)||terminalGoal(goal.status))continue;
   for(const child of goal.children){
    if(!child.context)continue;
    const job=jobs.find(job=>job.tabId===child.context?.tabId&&job.profileId===child.context.profileId&&this.matching(job));
    if(!job)continue;
    const grant=this.matching(job)!;grant.jobId=job.id;
    if(child.jobId!==job.id||child.status!==job.status||child.answer!==job.answer||child.error!==job.error){child.jobId=job.id;child.status=job.status;child.answer=job.answer;child.error=job.error;changed=true;}
   }
   if(changed)this.summarize(goal);
  }
  if(changed)void this.publish().catch(()=>undefined);
 }
 async cancel(id:string):Promise<void>{
  const goal=this.goals.find(goal=>goal.id===id&&goal.profileId===this.ports.readState().activeProfileId);
  if(!goal)throw new Error('현재 프로필의 목표 작업을 찾지 못했습니다.');
  if(terminalGoal(goal.status)||goal.status==='cancelling')return;
  this.revoked.add(id);goal.status='cancelling';goal.updatedAt=this.stamp();
  const publication=this.publish();
  const jobs=this.ports.readJobs().filter(job=>active(job.status)&&this.matching(job)?.goalId===id);
  const results=await Promise.allSettled([publication,this.ports.cancelPlan(id),...jobs.map(job=>this.ports.cancelJob(job.id))]);
  const failure=results.some(result=>result.status==='rejected');
  goal.status=failure?'interrupted':'cancelled';goal.error=failure?'실행 권한은 회수했지만 중지 응답을 모두 확인하지 못했습니다. 이미 전송한 행동은 되돌리지 않습니다.':null;
  for(const child of goal.children)if(active(child.status))child.status=failure?'unknown':'cancelled';
  if(!this.storageFailed)await this.publish();
 }
 interrupt():void{
  for(const goal of this.goals)if(!terminalGoal(goal.status)){this.revoked.add(goal.id);goal.status='interrupted';goal.error='AI 연결이 종료되었습니다. 자동 재실행하지 않습니다.';for(const child of goal.children)if(active(child.status))child.status='interrupted';}
  if(!this.storageFailed)void this.publish().catch(()=>undefined);
 }
}
