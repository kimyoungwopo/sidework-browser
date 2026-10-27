import type {AppCommand,BridgeCommand,BrowserContext,BrowserState,ExecutionContext,Job,TaskInput} from '../contract';
import {safePageUrl} from './codex-desktop';
export function assertExecutingJob(jobs:readonly Job[],context:ExecutionContext,leaseReady=true):void{
 if(!leaseReady)throw new Error('AI 실행 연결이 종료되었습니다.');
 const job=jobs.find(job=>job.id===context.jobId);
 if(!job||job.status!=='running'||job.profileId!==context.profileId||(job.computerUse&&job.tabId!==context.tabId))throw new Error('취소되었거나 다른 화면에 연결된 작업입니다.');
 if(context.smoothScroll!==undefined&&typeof context.smoothScroll!=='boolean')throw new Error('잘못된 스크롤 실행 모드입니다.');
 if(context.smoothScroll&&(!job.synchronizedScroll||job.computerUse||job.tabId!==context.tabId))throw new Error('동시 스크롤 작업 대상이 일치하지 않습니다.');
}
export function taskContext(state:BrowserState,tabId=state.activeTabId??'',computerUse=false,shareScreen=false):BrowserContext{
 const tab=state.tabs.find(tab=>tab.id===tabId&&tab.profileId===state.activeProfileId);const profile=state.profiles.find(p=>p.id===state.activeProfileId);
 if(!tab||!profile||!(state.paneTabIds??[state.activeTabId]).includes(tabId))throw new Error('현재 표시된 작업 화면을 선택하세요.');
 if(computerUse){if(!shareScreen)throw new Error('작업 화면 전송에 동의해야 합니다.');if(profile.incognito)throw new Error('비공개 프로필에서는 화면 전송 작업을 실행하지 않습니다.');if(!/^https?:\/\//i.test(tab.url))throw new Error('작업할 웹페이지를 먼저 여세요.');}
 return {profileId:tab.profileId,tabId:tab.id};
}

export function sectionBatchInputs(state:BrowserState,jobs:readonly Job[],command:Extract<AppCommand,{type:'jobs.startSections'}>):TaskInput[]{
 const active=jobs.filter(job=>['queued','running','awaiting_approval'].includes(job.status));
 if(command.consent!==true||command.tasks.length<1||command.tasks.length>8||active.length+command.tasks.length>8)throw new Error('화면 공유 동의와 실행 가능한 작업 수를 확인하세요.');
 if(new Set(command.tasks.map(task=>task.tabId)).size!==command.tasks.length)throw new Error('같은 화면의 작업을 중복 시작할 수 없습니다.');
 if(command.tasks.some(task=>active.some(job=>job.profileId===state.activeProfileId&&job.tabId===task.tabId)))throw new Error('진행 중인 화면의 작업을 먼저 중지하세요.');
 return command.tasks.map(task=>{
  const context=taskContext(state,task.tabId,true,true),tab=state.tabs.find(tab=>tab.id===context.tabId&&tab.profileId===context.profileId)!;
  if(tab.isLoading||tab.url!==task.expectedUrl||tab.revision!==task.expectedRevision)throw new Error('페이지 문서가 변경되었습니다. 요청과 화면 공유 동의를 다시 확인하세요.');
  safePageUrl(tab.url);
  return{prompt:task.prompt,...context,computerUse:true,shareScreen:true,initialDocument:{url:task.expectedUrl,revision:task.expectedRevision}};
 });
}

export async function startSectionJobs(state:BrowserState,jobs:readonly Job[],input:Extract<AppCommand,{type:'jobs.startSections'}>,send:(command:BridgeCommand)=>Promise<unknown>):Promise<void>{
 const inputs=sectionBatchInputs(state,jobs,input);
 await send({type:'startBatch',inputs});
}

export function visibleBatchInputs(state:BrowserState,jobs:readonly Job[],command:Extract<AppCommand,{type:'jobs.startVisible'}>):TaskInput[]{
 if(command.shareScreen!==true)throw new Error('보이는 작업 화면의 내용 전송 동의가 필요합니다.');
 const computerUse=command.computerUse!==false;
 if(command.synchronizedScroll&&computerUse)throw new Error('동시 첫 스크롤은 DOM 모드에서만 사용할 수 있습니다.');
 const ids=state.paneTabIds??(state.activeTabId?[state.activeTabId]:[]);
 if(ids.length>8||new Set(ids).size!==ids.length)throw new Error('잘못된 작업 화면 묶음입니다.');
 const active=jobs.filter(job=>['queued','running','awaiting_approval'].includes(job.status));
 const inputs:TaskInput[]=[];
 for(const id of ids){
  const tab=state.tabs.find(tab=>tab.id===id&&tab.profileId===state.activeProfileId);
  if(!tab)throw new Error('현재 표시된 작업 화면을 선택하세요.');
  if(['about:blank','about:newtab',''].includes(tab.url))continue;
  const busy=active.some(job=>job.tabId===id&&job.profileId===tab.profileId);
  if(busy){if(command.synchronizedScroll)throw new Error('진행 중인 화면을 제외하거나 작업을 먼저 중지하세요.');continue;}
  inputs.push({prompt:command.prompt,...taskContext(state,id,computerUse,true),computerUse,shareScreen:true});
 }
 if(!inputs.length||command.synchronizedScroll&&inputs.length<2)throw new Error('동시에 실행할 웹페이지를 두 개 이상 여세요.');
 if(active.length+inputs.length>8)throw new Error('실행 가능한 작업 수를 초과했습니다.');
 return inputs;
}

/** Post worker abort first; stop owned motion without waiting for worker I/O. */
export async function cancelOwnedExecution(cancelRuntime:()=>Promise<unknown>,stopScroll:()=>Promise<void>,stopVisuals?:()=>Promise<void>):Promise<void>{
 const invoke=(callback:()=>Promise<unknown>)=>{try{return Promise.resolve(callback());}catch(error){return Promise.reject(error);}};
 const cancellation=invoke(cancelRuntime),stopped=invoke(stopScroll),visuals=stopVisuals?invoke(stopVisuals):Promise.resolve();
 const results=await Promise.allSettled([cancellation,stopped,visuals]);
 const failed=results.find(result=>result.status==='rejected');
 if(failed?.status==='rejected')throw failed.reason;
}
