import { CodexPlanner, runPlannerProcess } from '../src/provider/codex';
import { DEFAULT_SETTINGS } from '../src/contract';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const workDir = resolve('qa/provider-context');
  await mkdir(workDir,{recursive:true});
  let verified = false;
  const planner = new CodexPlanner({binary:process.env.SIDEWORK_CODEX_PATH ?? 'codex',workDir,onLiveVerified:()=>{verified=true;},runner:async(request)=>{
    const raw=await runPlannerProcess(request);
    const metadata=raw.split('\n').filter(Boolean).map((line)=>{const e=JSON.parse(line) as {type?:string;item?:{type?:string}};return{eventType:e.type,itemType:e.item?.type};});
    await writeFile('qa/provider-event-metadata.json',JSON.stringify(metadata,null,2));
    console.log('Provider event metadata:',JSON.stringify(metadata));
    for (const line of raw.split('\n').filter(Boolean)) { const e=JSON.parse(line) as {item?:{type?:string;message?:string;text?:string}}; if(e.item?.type==='error') console.log('Provider config warning:',String(e.item.message??e.item.text??'').replace(/(Bearer\\s+)\\S+/gi,'$1[redacted]').slice(0,600)); }
    return raw;
  }});
  const result = await planner.next({
    prompt:'이 테스트 페이지에서 두 과일 이름과 색상만 한국어로 정리하고 finish로 끝내세요. 도구 호출은 하지 마세요.',
    observation:{profileId:'qa-profile',tabId:'qa-tab',revision:1,url:'http://127.0.0.1/sidework-owned-fixture',title:'명시적 합성 QA 페이지',text:'이것은 Sidework 자체 테스트용 합성 자료입니다. 사과는 빨강입니다. 바나나는 노랑입니다.',elements:[],capturedAt:new Date().toISOString()},
    settings:{...DEFAULT_SETTINGS,permissionMode:'read-only'},history:[],memory:[],signal:AbortSignal.timeout(130000),
  });
  if (!verified || result.action.type !== 'finish' || !result.action.text.includes('사과') || !result.action.text.includes('바나나')) throw new Error('실제 모델 응답 검증 실패');
  const evidence={fixture:'synthetic-public-text-only',provider:'official local Codex CLI',authenticated:'previous login status',liveResponseVerified:verified,result,at:new Date().toISOString()};
  await writeFile('qa/provider-live.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
}
void main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Provider smoke failed');process.exitCode=1;});
