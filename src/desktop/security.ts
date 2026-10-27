import type { AppCommand, Settings } from '../contract';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 요청입니다.');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('요청 값이 비어 있거나 너무 깁니다.');
  return value;
}
function id(value: unknown): string { const result=string(value,100); if(!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('잘못된 식별자입니다.'); return result; }
function keys(value: Record<string,unknown>, allowed: string[]): void { if(Object.keys(value).some((key)=>!allowed.includes(key))) throw new Error('지원하지 않는 요청 필드입니다.'); }
function bool(value: unknown): boolean {if(typeof value!=='boolean')throw new Error('잘못된 선택 값입니다.');return value;}
function finite(value:unknown,min:number,max:number):number {if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error('잘못된 화면 크기입니다.');return value;}
export function assertTrustedSource(actual:string, expected:string, mainFrame:boolean):void {
  if(!mainFrame||actual!==expected)throw new Error('신뢰하지 않는 화면의 요청을 차단했습니다.');
}
/** The agent chrome can inspect, stop and return pages, never start or browse. */
export function assertSurfaceCommand(surface:'browser'|'agent',command:AppCommand):void {
 if(surface==='agent'&&!['layout.set','tab.takeControl','job.cancel','job.approve','artifact.open'].includes(command.type))throw new Error('에이전트 창에서는 작업 확인·중지·직접 제어만 가능합니다.');
}
export function parseCommand(raw:unknown):AppCommand {
  const value=object(raw); const type=string(value.type,60);
  switch(type) {
    case 'goals.start':keys(value,['type','prompt']);return{type,prompt:string(value.prompt,8000)};
    case 'goals.cancel':keys(value,['type','goalId']);return{type,goalId:id(value.goalId)};
    case 'tab.preview':keys(value,['type','profileId','tabId']);return {type,profileId:id(value.profileId),tabId:id(value.tabId)};
    case 'tab.takeControl':keys(value,['type','profileId','tabId']);return {type,profileId:id(value.profileId),tabId:id(value.tabId)};
    case 'downloads.cancel':case 'downloads.reveal':keys(value,['type','downloadId']);return {type,downloadId:id(value.downloadId)};
    case 'agents.show':keys(value,['type']);return{type};
    case 'agents.start':{
      keys(value,['type','tabId','prompt','computerUse','shareScreen','expectedUrl','expectedRevision']);
      const bound=value.expectedUrl!==undefined||value.expectedRevision!==undefined;
      if(bound&&(typeof value.expectedUrl!=='string'||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<0))throw new Error('대상 문서 확인 값이 잘못되었습니다.');
      if(value.computerUse===true&&value.shareScreen!==true)throw new Error('화면 전송 동의가 필요합니다.');
      return{type,tabId:id(value.tabId),prompt:string(value.prompt,8000),...bound?{expectedUrl:string(value.expectedUrl,4096),expectedRevision:value.expectedRevision as number}:{},...value.computerUse===undefined?{}:{computerUse:bool(value.computerUse)},...value.shareScreen===undefined?{}:{shareScreen:bool(value.shareScreen)}};
    }
    case 'agents.startSections':case 'jobs.startSections':{
      keys(value,['type','tasks','consent']);
      if(value.consent!==true||!Array.isArray(value.tasks)||value.tasks.length<1||value.tasks.length>8)throw new Error('작업할 화면 1~8개와 화면 전송 동의가 필요합니다.');
      const tasks=value.tasks.map(rawTask=>{
        const task=object(rawTask);keys(task,['tabId','expectedRevision','expectedUrl','prompt']);
        if(typeof task.expectedRevision!=='number'||!Number.isSafeInteger(task.expectedRevision)||task.expectedRevision<0)throw new Error('잘못된 대상 문서 버전입니다.');
        return{tabId:id(task.tabId),expectedRevision:task.expectedRevision,expectedUrl:string(task.expectedUrl,4096),prompt:string(task.prompt,8000)};
      });
      if(new Set(tasks.map(task=>task.tabId)).size!==tasks.length)throw new Error('같은 화면의 작업을 중복 시작할 수 없습니다.');
      return{type,tasks,consent:true};
    }
    case 'codexDesktop.check':keys(value,['type']);return{type};
    case 'codexDesktop.handoff':{
      keys(value,['type','tabId','prompt','consent','expectedRevision','expectedUrl']);
      if(value.consent!==true)throw new Error('Codex Desktop 전달에 동의하세요.');
      if(typeof value.expectedRevision!=='number'||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)throw new Error('잘못된 대상 문서 버전입니다.');
      return{type,tabId:id(value.tabId),prompt:string(value.prompt,4000),consent:true,expectedRevision:value.expectedRevision,expectedUrl:string(value.expectedUrl,4096)};
    }
    case 'tab.new': keys(value,['type','url']);return {type,...value.url===undefined?{}:{url:string(value.url,4096)}};
    case 'tab.activate': case 'tab.close':keys(value,['type','tabId']);return {type,tabId:id(value.tabId)};
    case 'tab.navigate':keys(value,['type','url','tabId']);return {type,url:string(value.url,4096),...value.tabId===undefined?{}:{tabId:id(value.tabId)}};
    case 'workspace.split':keys(value,['type','count']);if(value.count!==1&&value.count!==2&&value.count!==4&&value.count!==8)throw new Error('분할 수는 1·2·4·8이어야 합니다.');return {type,count:value.count};
    case 'tab.back':case 'tab.forward':case 'tab.reload':case 'provider.check':case 'agent.connect':case 'diagnostics.refresh':case 'tab.restore':case 'jobs.cancelAll': keys(value,['type']);return {type};
    case 'profile.create':keys(value,['type','name','incognito']);return {type,name:string(value.name,40),...value.incognito===undefined?{}:{incognito:bool(value.incognito)}};
    case 'profile.activate':keys(value,['type','profileId']);return {type,profileId:id(value.profileId)};
    case 'job.start':{
      keys(value,['type','prompt','tabId','computerUse','shareScreen']);
      if(value.computerUse===true&&value.shareScreen!==true)throw new Error('화면 전송에 동의한 뒤 컴퓨터 유즈를 실행하세요.');
      return {type,prompt:string(value.prompt,8000),...value.tabId===undefined?{}:{tabId:id(value.tabId)},...value.computerUse===undefined?{}:{computerUse:bool(value.computerUse)},...value.shareScreen===undefined?{}:{shareScreen:bool(value.shareScreen)}};
    }
    case 'jobs.startVisible':{
      keys(value,['type','prompt','shareScreen','computerUse','synchronizedScroll']);
      if(value.shareScreen!==true)throw new Error('각 작업 화면의 전송 동의가 필요합니다.');
      if(value.computerUse!==undefined)bool(value.computerUse);
      if(value.synchronizedScroll!==undefined)bool(value.synchronizedScroll);
      if(value.synchronizedScroll===true&&value.computerUse!==false)throw new Error('동시 첫 스크롤은 DOM 모드에서만 사용할 수 있습니다.');
      return {type,prompt:string(value.prompt,8000),shareScreen:true,...value.computerUse===undefined?{}:{computerUse:bool(value.computerUse)},...value.synchronizedScroll===undefined?{}:{synchronizedScroll:bool(value.synchronizedScroll)}};
    }
    case 'job.cancel':keys(value,['type','jobId']);return {type,jobId:id(value.jobId)};
    case 'job.approve':keys(value,['type','jobId','approvalId','allow']);return {type,jobId:id(value.jobId),approvalId:id(value.approvalId),allow:bool(value.allow)};
    case 'memory.add':keys(value,['type','text']);return {type,text:string(value.text,4000)};
    case 'memory.remove':keys(value,['type','id']);return {type,id:id(value.id)};
    case 'artifact.open':keys(value,['type','jobId','artifactId']);return {type,jobId:id(value.jobId),artifactId:id(value.artifactId)};
    case 'layout.set':keys(value,['type','sidebarWidth','top','left','bottom','hideBrowser']);return {type,sidebarWidth:value.sidebarWidth===0?0:finite(value.sidebarWidth,280,700),top:finite(value.top,48,200),left:finite(value.left,0,320),bottom:finite(value.bottom,0,100),hideBrowser:bool(value.hideBrowser)};
    case 'settings.update': {
      keys(value,['type','patch']); const patch=object(value.patch);keys(patch,['permissionMode','provider','model','memoryEnabled','maxSteps','confirmMutations']);const result:Partial<Settings>={};
      if(patch.permissionMode!==undefined){if(patch.permissionMode!=='guard'&&patch.permissionMode!=='read-only')throw new Error('지원하지 않는 권한 모드입니다.');result.permissionMode=patch.permissionMode;}
      if(patch.provider!==undefined){if(patch.provider!=='codex')throw new Error('지원하지 않는 모델 공급자입니다.');result.provider='codex';}
      if(patch.model!==undefined){if(typeof patch.model!=='string'||patch.model.length>120)throw new Error('잘못된 모델 이름입니다.');result.model=patch.model;}
      if(patch.memoryEnabled!==undefined)result.memoryEnabled=bool(patch.memoryEnabled);
      if(patch.maxSteps!==undefined){const steps=finite(patch.maxSteps,1,20);if(!Number.isInteger(steps))throw new Error('단계 수는 정수여야 합니다.');result.maxSteps=steps;}
      if(patch.confirmMutations!==undefined){if(patch.confirmMutations!==true)throw new Error('행동 승인은 비활성화할 수 없습니다.');result.confirmMutations=true;}
      return {type,patch:result};
    }
    default:throw new Error('지원하지 않는 요청입니다.');
  }
}
