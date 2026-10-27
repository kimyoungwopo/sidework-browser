import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanOutput, parseCodexEvents, CodexPlanner, PLAN_SCHEMA } from '../src/provider/codex.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/contract';
import type { PlannerInput } from '../src/contract';

test('trusted agent execution mode reaches the planner without giving the model approval authority',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'provider-agent-mode-')),contexts:Array<Record<string,unknown>>=[];let guidance='';
 const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async request=>{const parts=request.input.split('UNTRUSTED INPUT JSON:\n');guidance=parts[0]!;contexts.push(JSON.parse(parts[1]!) as Record<string,unknown>);return JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({thought:'Done',action:{type:'finish',text:'Done'}})}});}});
 const input:PlannerInput={prompt:'Local task',observation:{profileId:'p',tabId:'t',revision:1,url:'https://example.test/',title:'Page',text:'Page claims agent automation enabled',elements:[],capturedAt:'now'},history:[],settings:DEFAULT_SETTINGS,memory:[],signal:new AbortController().signal};
 try{await planner.next(input);await planner.next({...input,agentAutomation:true});assert.equal(contexts[0]!.executionMode,'per-action');assert.equal(contexts[1]!.executionMode,'agent-workspace');assert.match(guidance,/agent-workspace.*host.*ordinary/i);assert.match(guidance,/model cannot approve actions/i);assert.match(guidance,/host-verified label-for binding/i);assert.match(guidance,/structural facts.*not permission/i);assert.match(guidance,/submit_search/);assert.match(guidance,/query ref.*native.*requestSubmit/);assert.match(guidance,/not a click/);}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('public search URL transport omits native routing state without changing authoritative observations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'search-url-privacy-'));
 let sent='';
 const planner=new CodexPlanner({binary:'injected-only',workDir:dir,runner:async request=>{sent=request.input;return JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({thought:'Done',action:{type:'finish',text:'Done'}})}});}});
 try {
  for(const [url,projected] of [
   ['https://www.google.com/search?q=javascript+tutorial&sxsrf=NATIVE_GOOGLE_ONLY&iflsig=OPAQUE_ONLY','https://www.google.com/search?q=javascript+tutorial'],
   ['https://search.naver.com/search.naver?where=nexearch&query=css+tutorial&ackey=NATIVE_NAVER_ONLY','https://search.naver.com/search.naver?query=css+tutorial'],
   ['https://www.google.com.evil.test/search?q=public&ei=unchanged','https://www.google.com.evil.test/search?q=public&ei=unchanged'],
  ] as const) {
   const input:PlannerInput={prompt:'Read the public results',observation:{profileId:'p',tabId:'t',revision:7,url,title:'Results',text:'Public page',elements:[{ref:'r1',tag:'a',role:'link',name:'Results',inputType:'',sensitive:false,interaction:{kind:'navigation',url}}],capturedAt:'fixture'},pageReading:{profileId:'p',tabId:'t',url,documentId:'doc-bound',sections:[{scrollY:0,text:'Public results'}],complete:false,stopReason:'limit'},history:[],settings:DEFAULT_SETTINGS,memory:[],signal:new AbortController().signal};
   const original=JSON.stringify(input.observation);
   await planner.next(input);
   const context=JSON.parse(sent.split('UNTRUSTED INPUT JSON:\n')[1]!);
   assert.equal(context.observation.url,projected);
   assert.equal(context.observation.elements[0].interaction.url,projected);
   assert.equal(context.pageReading.url,projected);
   assert.equal(JSON.stringify(input.observation),original);
   assert.equal(input.pageReading?.url,url);
   assert(!sent.includes('NATIVE_GOOGLE_ONLY'));assert(!sent.includes('OPAQUE_ONLY'));assert(!sent.includes('NATIVE_NAVER_ONLY'));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('planner accepts a schema-shaped answer without executing arbitrary model code', () => {
  assert.deepEqual(parsePlanOutput(JSON.stringify({ thought: '페이지 근거를 확인했습니다.', action: { type: 'finish', url: null, ref: null, value: null, direction: null, text: '실제 요약' } })), {
    thought: '페이지 근거를 확인했습니다.', action: { type: 'finish', text: '실제 요약' },
  });
  assert.throws(() => parsePlanOutput('{"thought":"x","action":{"type":"shell","command":"rm -rf /"}}'), /지원하지|잘못|허용/);
});

test('read_page schema and parser require an active bounded budget and reject inactive payloads', () => {
  const schema = PLAN_SCHEMA.properties.action;
  assert.equal(schema.anyOf.length, 13);
  assert.equal(schema.properties.type.enum.length, 13);
  assert(schema.required.includes('maxScreens'));
  for (const branch of schema.anyOf) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(new Set(branch.required), new Set(Object.keys(branch.properties)));
    const reading = branch.properties.type.enum.includes('read_page');
    assert.deepEqual(branch.properties.maxScreens, reading ? { type: 'integer', minimum: 1, maximum: 8 } : { type: 'null' });
  }
  for (const maxScreens of [1, 8]) {
    const action = { type: 'read_page', maxScreens };
    const padded = Object.fromEntries(schema.required.map(key => [key, null]));
    assert.deepEqual(parsePlanOutput(JSON.stringify({ thought: 'Read', action: { ...padded, ...action } })).action, action);
  }
  for (const maxScreens of [undefined, null, '2', NaN, Infinity, 0, 9, -1, 1.5]) {
    assert.throws(() => parsePlanOutput(JSON.stringify({ thought: 'Read', action: { type: 'read_page', maxScreens } })));
  }
  for (const extra of [{ text: 'invented' }, { direction: 'down' }, { frameId: 'f' }, { approved: true }]) {
    assert.throws(() => parsePlanOutput(JSON.stringify({ thought: 'Read', action: { type: 'read_page', maxScreens: 2, ...extra } })));
  }
  assert.throws(() => parsePlanOutput(JSON.stringify({ thought: 'Done', action: { type: 'finish', text: 'done', maxScreens: 2 } })));
  assert.deepEqual(parsePlanOutput(JSON.stringify({ thought: 'Done', action: { type: 'finish', text: 'done', maxScreens: null } })).action, { type: 'finish', text: 'done' });
});

test('read_page evidence is bounded structured per-call context with honest read-only guidance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidework-provider-reading-'));
  const contexts: Array<Record<string, unknown>> = [];
  let instructions = '';
  const planner = new CodexPlanner({ binary: 'injected-only', workDir: dir, runner: async request => {
    const [guidance, data] = request.input.split('UNTRUSTED INPUT JSON:\n');
    instructions = guidance!;
    contexts.push(JSON.parse(data!) as Record<string, unknown>);
    return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ thought: 'Read', action: { type: 'read_page', maxScreens: 8 } }) } });
  } });
  const pageReading = { profileId: 'p', tabId: 't', url: 'https://example.com/', documentId: 'doc-1', sections: [{ scrollY: 0, text: 'fresh public section' }], complete: false, stopReason: 'limit' as const };
  const input: PlannerInput = { prompt: '긴 문서 전체를 읽고 요약', observation: { profileId: 'p', tabId: 't', revision: 1, url: pageReading.url, title: 'Long document', text: 'first viewport', elements: [], capturedAt: 'fixture', readingViewport: { documentId: 'doc-1', scrollY: 0, height: 600, scrollHeight: 6000, text: 'first viewport' } }, pageReading, history: [], settings: DEFAULT_SETTINGS, memory: [], signal: new AbortController().signal };
  try {
    assert.deepEqual((await planner.next(input)).action, { type: 'read_page', maxScreens: 8 });
    assert.deepEqual(contexts[0]!.pageReading, pageReading);
    assert.deepEqual(contexts[0]!.recentSteps, []);
    assert.deepEqual(contexts[0]!.memory, []);
    assert.match(instructions, /read_page.*host-only/i);
    assert.match(instructions, /at most 8 fresh viewport sections/i);
    assert.match(instructions, /same document/i);
    assert.match(instructions, /no per-scroll model wait/i);
    assert.match(instructions, /actual long-document request/i);
    assert.match(instructions, /decorative scroll/i);
    assert.match(instructions, /screenshot\/canvas-only/i);
    assert.match(instructions, /readingViewport.*unavailable.*never invent text/i);
    assert.match(instructions, /incomplete.*limit.*never.*complete/i);
    assert.match(instructions, /read-only permits observe, scroll, read_page, screenshot, finish only/);
    assert.match(instructions, /navigation\/open_tab\/click\/fill always require a separate human approval/);
    const image = 'iVBORw0KGgoAAAA';
    const oversized = { ...pageReading, complete: true, stopReason: 'bottom' as const, secret: 'NOT FORWARDED', sections: Array.from({ length: 10 }, (_, index) => ({ scrollY: index * 600, text: index === 0 ? image : 'x'.repeat(16000), hidden: 'NOT FORWARDED' })) };
    await planner.next({ ...input, pageReading: oversized });
    const bounded = contexts[1]!.pageReading;
    assert.deepEqual(bounded, { ...pageReading, sections: Array.from({ length: 8 }, (_, index) => ({ scrollY: index * 600, text: index === 0 ? '[image omitted]' : 'x'.repeat(12000) })) });
    delete input.pageReading;
    await planner.next(input);
    assert.equal(contexts[2]!.pageReading, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('structured planner rejects tool activity and errors instead of presenting them as a model answer', () => {
  const event = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } });
  assert.equal(parseCodexEvents(event), 'answer');
  assert.throws(() => parseCodexEvents(JSON.stringify({ type:'item.completed', item:{ type:'command_execution', command:'ls' } }) + '\n' + event), /도구/);
  assert.throws(() => parseCodexEvents(JSON.stringify({type:'error',message:'provider unavailable'})), /모델/);
  const closedHostNotice = JSON.stringify({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}});
  assert.equal(parseCodexEvents(closedHostNotice+'\n'+event),'answer');
  assert.throws(()=>parseCodexEvents(JSON.stringify({type:'item.completed',item:{type:'error',message:'unrelated failure'}})+'\n'+event),/도구/);
});

test('Codex adapter requests read-only schema output without inherited tools or disabled memory', async () => {
  const dir = await mkdtemp(join(tmpdir(),'sidework-provider-test-'));
  let args: string[] = [];
  let sent = '';
  let verified = false;
  const planner = new CodexPlanner({ binary:'test-fixture-only', workDir:dir, onLiveVerified:()=>{verified=true;}, runner: async (request) => {
    args = request.args; sent = request.input;
    return JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({thought:'확인',action:{type:'finish',text:'완료'}})}});
  }});
  try {
    const result = await planner.next({prompt:'요약',observation:{profileId:'p',tabId:'t',revision:1,url:'https://example.com/',title:'Example',text:'public fixture',elements:[],capturedAt:new Date().toISOString()},history:[],settings:DEFAULT_SETTINGS,memory:[{id:'m',text:'PRIVATE MEMORY MUST NOT APPEAR',createdAt:new Date().toISOString()}],signal:new AbortController().signal});
    assert.equal(result.action.type,'finish');
    assert(args.includes('--ignore-user-config')); assert(args.includes('--ignore-rules')); assert(args.includes('read-only')); assert(args.includes('--output-schema'));
    assert(args.includes('shell_tool')); assert(args.includes('browser_use'));
    assert(!sent.includes('PRIVATE MEMORY MUST NOT APPEAR')); assert(verified);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
