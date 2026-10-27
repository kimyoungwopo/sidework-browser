import type { BrowserActionResult, BrowserContext, BrowserPort, CoreSnapshot, ExecutionContext, MainToWorker, Observation, WorkerToMain } from '../contract';
import { AgentRuntime } from '../core/runtime';
import { GoalPlanning } from '../core/goal-planning';
import { RuntimeStore } from '../core/store';
import { CodexPlanner } from '../provider/codex';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ParentPort } from 'electron';

const port = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort;
if (!port) throw new Error('Local bridge must run in an Electron utility process.');
const post = (message:WorkerToMain) => port.postMessage(message);
let runtime:AgentRuntime|null=null;
let goalPlanning:GoalPlanning|null=null;
let shuttingDown=false;
const requests = new Map<string,{resolve:(value:Observation|BrowserActionResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function browserRequest(message:Extract<WorkerToMain,{kind:'browser.request'}>):Promise<Observation|BrowserActionResult> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{requests.delete(message.id);reject(new Error('브라우저 제어 응답 시간이 초과됐습니다.'));},35000);
    requests.set(message.id,{resolve,reject,timer});post(message);
  });
}
const browser:BrowserPort={
  observe:async(context:BrowserContext,options)=>await browserRequest({kind:'browser.request',id:randomUUID(),operation:'observe',context,...options}) as Observation,
  execute:async(action,context:ExecutionContext)=>await browserRequest({kind:'browser.request',id:randomUUID(),operation:'execute',action,context}) as BrowserActionResult,
};
port.on('message',(event)=>{
  const message=event.data as MainToWorker;
  if(message.kind==='browser.response') {
    const request=requests.get(message.id);if(!request)return;requests.delete(message.id);clearTimeout(request.timer);
    if(message.ok&&message.value)request.resolve(message.value);else request.reject(new Error(message.error??'브라우저 요청이 실패했습니다.'));return;
  }
  if(message.kind==='shutdown') {
    if(shuttingDown)return;
    shuttingDown=true;
    void Promise.allSettled([runtime?.shutdown(),goalPlanning?.shutdown()]).then(()=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(new Error('앱이 종료됐습니다.'));}requests.clear();process.exit(0);});return;
  }
  if(shuttingDown)return;
  if(message.kind==='init') {
    if(runtime)return;
    const planner=new CodexPlanner({binary:message.codexPath,workDir:join(message.dataRoot,'model-context'),maxProcesses:message.maxPlannerProcesses,onActivity:activity=>post({kind:'provider.activity',activity}),onLiveVerified:()=>post({kind:'provider.verified'})});
    const controller=new AgentRuntime({store:new RuntimeStore(message.dataRoot),browser,planner,onChange:(snapshot:CoreSnapshot)=>post({kind:'snapshot',snapshot})});
    runtime=controller;
    goalPlanning=new GoalPlanning(planner,()=>controller.snapshot().settings);
    void runtime.initialize().then(()=>post({kind:'ready'})).catch(()=>{post({kind:'response',id:'init',ok:false,error:'로컬 작업 저장소를 열지 못했습니다.'});});return;
  }
  if(message.kind==='command') {
    const controller=runtime;
    if(!controller){post({kind:'response',id:message.id,ok:false,error:'로컬 브리지가 아직 준비되지 않았습니다.'});return;}
    void (async()=>{
      try {
        let value:unknown;
        switch(message.command.type) {
          case 'goal.plan':if(!goalPlanning)throw new Error('목표 계획기가 아직 준비되지 않았습니다.');value=await goalPlanning.plan(message.command.goalId,message.command.prompt);break;
          case 'goal.cancelPlan':if(!goalPlanning)throw new Error('목표 계획기가 아직 준비되지 않았습니다.');await goalPlanning.cancel(message.command.goalId);break;
          case 'start':value=await controller.start(message.command.input);break;
          case 'startTogether':value=await controller.startTogether(message.command.inputs);break;
          case 'startBatch':value=await controller.startBatch(message.command.inputs);break;
          case 'cancel':await controller.cancel(message.command.jobId);break;
          case 'cancelAll':await controller.cancelAll();break;
          case 'approve':await controller.approve({jobId:message.command.jobId,approvalId:message.command.approvalId,allow:message.command.allow});break;
          case 'settings':await controller.updateSettings(message.command.patch);break;
          case 'memory.add':await controller.addMemory(message.command.text);break;
          case 'memory.remove':await controller.removeMemory(message.command.id);break;
        }
        post({kind:'response',id:message.id,ok:true,value});
      } catch(error) {post({kind:'response',id:message.id,ok:false,error:error instanceof Error?error.message.slice(0,500):'작업 요청을 처리하지 못했습니다.'});}
    })();
  }
});
