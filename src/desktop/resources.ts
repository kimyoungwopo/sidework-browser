import type { BrowserTab, ResourceSample } from '../contract';
interface MetricInput { pid:number; type:string; memory:{workingSetSize:number;peakWorkingSetSize:number}; cpu:{percentCPUUsage:number} }
const roles=new Set(['Browser','Tab','Utility','Zygote','Sandbox helper','GPU','Pepper Plugin','Pepper Plugin Broker','Unknown']);
function nonnegative(value:number):number{return Number.isFinite(value)&&value>=0?value:0;}
export function createResourceSample(metrics:readonly MetricInput[],tabs:readonly BrowserTab[],checkpoints:{browser:number|null;agent:number|null}):ResourceSample{
 const liveTabs=tabs.filter(tab=>tab.lifecycle!=='dormant').length;
 return {sampledAt:new Date().toISOString(),processes:metrics.slice(0,256).map(m=>({pid:nonnegative(m.pid),role:roles.has(m.type)?m.type:'Unknown',workingSetKB:nonnegative(m.memory.workingSetSize),peakWorkingSetKB:nonnegative(m.memory.peakWorkingSetSize),cpuPercent:nonnegative(m.cpu.percentCPUUsage)})),tabs:tabs.length,liveTabs,dormantTabs:tabs.length-liveTabs,processUptimeAtBrowserReadyMs:checkpoints.browser,processUptimeAtAgentReadyMs:checkpoints.agent,caveat:'Electron 프로세스의 working set 지표입니다. 공유 페이지 중복·macOS 압축/스왑 때문에 고유 물리 RAM이 아니며, 외부 모델 CLI 프로세스는 포함되지 않을 수 있습니다. 준비 시간은 프로세스 uptime 체크포인트이지 전체 cold launch 실측이 아닙니다.'};
}
