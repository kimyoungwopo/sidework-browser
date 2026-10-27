import type {BrowserPort,BrowserState,Job,WorkerToMain,Observation,BrowserActionResult} from '../contract';
import type {PageAuthority} from './page-authority';
import {assertExecutingJob} from './tasks';
import {assertAgentPage} from './agent-scope';
import {safePageUrl} from './codex-desktop';
import {isAutomaticAgentAction} from '../agent-action-policy';
import {goalScopeAllows} from '../goal-navigation';

type Services={authority:Pick<PageAuthority,'assertRequest'|'registerResult'>;browser:BrowserPort;readJobs:()=>readonly Job[];readState:()=>BrowserState;assertGoal?:(job:Job)=>void;readPermissionMode?:()=>import('../contract').PermissionMode};
type TakeServices={authority:Pick<PageAuthority,'takeControl'|'completeTakeControl'>;readJobs:()=>readonly Job[];readState:()=>BrowserState;invalidate:(context:import('../contract').BrowserContext)=>void;cancelJob:(id:string)=>Promise<void>;publish:()=>void};
/** Authority changes before waiting for cancellation; terminal markers reflect acknowledgements, not intent. */
export async function takeTaskPageControl(services:TakeServices,context:import('../contract').BrowserContext):Promise<void>{
 const receipt=services.authority.takeControl(services.readState(),services.readJobs(),context);
 try{
  services.invalidate(context);services.publish();
  const invoke=(id:string)=>{try{return Promise.resolve(services.cancelJob(id));}catch(error){return Promise.reject(error);}};
  const results=await Promise.allSettled(receipt.jobIds.map(invoke));
  const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
  services.authority.completeTakeControl(context,receipt.generation,true);services.publish();
 }catch(error){services.authority.completeTakeControl(context,receipt.generation,false);services.publish();throw error;}
}

/** No shared queue: caller retains its explicit per-page OperationQueue. */
export async function routeTaskPage(services:Services,request:Extract<WorkerToMain,{kind:'browser.request'}>):Promise<Observation|BrowserActionResult>{
 const jobId=request.operation==='observe'?request.jobId:request.context.jobId;
 if(!jobId)throw new Error('작업 식별자가 없는 브라우저 요청입니다.');
 const assertGoal=()=>{const job=services.readJobs().find(job=>job.id===jobId);if(job?.agentScope?.goalId){if(!services.assertGoal)throw new Error('Main goal authority unavailable');services.assertGoal(job);}};
 const jobs=services.readJobs();
 assertGoal();
 services.authority.assertRequest(jobs,request.context,jobId,request.operation);
 assertAgentPage(jobs,services.readState(),request.context,jobId);
 const scoped=jobs.find(job=>job.id===jobId)?.agentScope;
 if(request.operation==='observe'){
  const job=jobs.find(job=>job.id===jobId);
  if(!job||(request.computerUse===true)!==(job.computerUse===true)||(request.computerUse&&(!request.shareScreen||!job.shareScreen)))throw new Error('허용된 작업 관찰이 아닙니다.');
  const value=await services.browser.observe(request.context,{computerUse:request.computerUse,shareScreen:request.shareScreen,jobId});
  services.authority.assertRequest(services.readJobs(),request.context,jobId,'observe');
  assertAgentPage(services.readJobs(),services.readState(),request.context,jobId);assertGoal();
  if(scoped)safePageUrl(value.url);
  if(scoped && (value.profileId!==request.context.profileId || value.tabId!==request.context.tabId || !goalScopeAllows(scoped,value.url)))throw new Error('Unexpected delegated observation');
  return value;
 }
 assertExecutingJob(jobs,request.context);
 if(scoped && (request.action.type==='open_tab' || (request.action.type==='navigate' && !goalScopeAllows(scoped,request.action.url))))throw new Error('Action leaves the delegated page scope');
 if(request.action.type==='submit_search'){
  const assertNative=()=>{
   const current=services.readJobs().find(item=>item.id===jobId),page=services.readState().tabs.find(tab=>tab.id===request.context.tabId && tab.profileId===request.context.profileId);
   services.authority.assertRequest(services.readJobs(),request.context,jobId,'execute');
   assertAgentPage(services.readJobs(),services.readState(),request.context,jobId);assertGoal();
   if(services.readPermissionMode?.()!=='guard' || !current?.agentScope?.goalId || current.status!=='running' || current.computerUse || current.shareScreen || page?.ownership!=='agent')throw new Error('Native search submission requires live goal DOM guard authority');
   return current.agentScope;
  };
  assertNative();
  const fresh=await services.browser.observe(request.context,{jobId,computerUse:false,shareScreen:false});
  const liveScope=assertNative();
  if(fresh.profileId!==request.context.profileId || fresh.tabId!==request.context.tabId || fresh.revision!==request.context.expectedRevision || !isAutomaticAgentAction(request.action,fresh,liveScope))throw new Error('Native search query or destination changed');
 }
 const priorPages=request.action.type==='open_tab'?new Set(services.readState().tabs.map(tab=>tab.id)):null;
 const value=await services.browser.execute(request.action,request.context);
 services.authority.assertRequest(services.readJobs(),request.context,jobId,'execute');
 assertAgentPage(services.readJobs(),services.readState(),request.context,jobId);assertGoal();
 if(scoped && (value.context.profileId!==request.context.profileId || value.context.tabId!==request.context.tabId))throw new Error('Unexpected delegated result page');
 if(priorPages?.has(value.context.tabId))throw new Error('open_tab must return a newly created page, not an existing page');
 services.authority.registerResult(services.readJobs(),request.context,jobId,request.action,value,services.readState());
 return value;
}
