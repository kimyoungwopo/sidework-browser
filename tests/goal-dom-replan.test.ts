import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../src/core/runtime.ts';
import { RuntimeStore } from '../src/core/store.ts';
import type { BrowserAction, CoreSnapshot, ExecutionContext, Observation, PlannerInput, PlanStep, TaskInput } from '../src/contract.ts';

const done: PlanStep = { thought: 'Observed completed interaction', action: { type: 'finish', text: 'Completed' } };
const isDiscard = (event: { kind: string; text: string }) => event.kind === 'status' && event.text.includes('계획을 폐기');
async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  assert.fail('Runtime did not settle');
}
async function fixture(options: {
  legacy?: boolean;
  focused?:boolean;
  plan: (input: PlannerInput, mutate: (patch?: Partial<Observation>) => void) => PlanStep;
  execute?: (mutate: (patch?: Partial<Observation>) => void, action: BrowserAction) => void;
  beforeObserve?: (mutate: (patch?: Partial<Observation>) => void) => void;
  onChange?: (snapshot: CoreSnapshot, runtime: AgentRuntime) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), 'goal-dom-replan-'));
  let document: Observation = {
    profileId: 'p', tabId: 'a', revision: 1, url: 'https://example.com/docs', title: 'Docs', text: 'Original search field', capturedAt: 'now',
    elements: [{ ref: 'r1', tag: 'input', role: 'textbox', name: 'Search', inputType: 'search', sensitive: false, interaction: { kind: 'input' } }],
    readingViewport: { documentId: 'doc-a', scrollY: 0, height: 800, scrollHeight: 800, text: 'Original document' },
  };
  if(options.focused)document={...document,url:'https://www.naver.com/',readingViewport:undefined,observationMode:'search-form',documentId:'doc-a',elements:[{...document.elements[0]!,role:'combobox',interaction:{kind:'input',submission:{kind:'naver-native-get',method:'get',url:'https://search.naver.com/search.naver'}}}]};
  const plans: PlannerInput[] = [];
  const executed: { action: BrowserAction; context: ExecutionContext }[] = [];
  // This is an explicit DOM mutation, not a revision inferred from planner/observe counts.
  const mutate = (patch: Partial<Observation> = {}) => {
    document = { ...document, revision: document.revision + 1, text: 'Replacement search field', elements: [{ ...document.elements[0]!, ref: `r${document.revision + 1}` }], ...patch };
  };
  const runtime = new AgentRuntime({
    store: new RuntimeStore(join(root, 'store')),
    browser: {
      observe: async () => { options.beforeObserve?.(mutate); return structuredClone(document); },
      execute: async (action, context) => {
        executed.push({ action: structuredClone(action), context: structuredClone(context) });
        assert.equal(context.expectedRevision, document.revision);
        if ('ref' in action) assert(document.elements.some(element => element.ref === action.ref));
        options.execute?.(mutate, action);
        return { context, message: 'Fixture performed current action' };
      },
    },
    planner: { next: async input => { plans.push(input); return options.plan(input, mutate); } },
    onChange: snapshot => options.onChange?.(snapshot, runtime),
  });
  await runtime.initialize();
  const input: TaskInput = {
    prompt: 'Search the task-owned page', profileId: 'p', tabId: 'a', computerUse: false, executionEpoch: 0,
    initialDocument: { url: document.url, revision: 1, ...options.legacy ? {} : { documentId: 'doc-a' } },
    agentScope: { areaId: 'area-a', origin: options.focused?'https://www.naver.com':'https://example.com', expiresAt: new Date(Date.now() + 600000).toISOString(), ...options.legacy ? {} : { goalId: 'goal-a', allowedOrigins: options.focused?['https://www.naver.com','https://search.naver.com']:['https://example.com'] } },
  };
  return {
    runtime, input, plans, executed,
    async run() { await runtime.start(input); await until(() => !runtime.snapshot().activeJobId); return runtime.snapshot().jobs[0]!; },
    async close() { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); },
  };
}

for(const type of ['fill','submit_search'] as const)test(`focused search without readingViewport discards ${type} and asks for a new decision with a fresh ref`,async()=>{
 let changed=false;
 const f=await fixture({focused:true,plan(input,mutate){
  if(input.history.some(e=>e.kind==='action'))return done;
  const action:BrowserAction=type==='fill'?{type,ref:input.observation.elements[0]!.ref,value:changed?'new decision':'old proposal'}:{type,ref:input.observation.elements[0]!.ref};
  if(!changed){changed=true;mutate();}
  return {thought:changed?'New focused decision':'Original proposal',action};
 }});
 try{const job=await f.run();assert.equal(f.plans[0]!.observation.readingViewport,undefined);assert.equal(job.status,'completed',JSON.stringify(job.events));assert.equal(f.plans.length,3);assert.equal(job.events.filter(isDiscard).length,1);assert.equal(f.executed.length,1);assert.equal('ref' in f.executed[0]!.action&&f.executed[0]!.action.ref,'r2');assert(!f.executed.some(e=>'ref' in e.action&&e.action.ref==='r1'));assert.equal(job.steps,3);}finally{await f.close();}
});

for(const scenario of ['changed-document','missing-document','changed-view','changed-url','changed-profile','changed-tab','unknown-outcome','cancel','endless'] as const)test(`focused replan identity and outcome boundary: ${scenario}`,async()=>{
 let cancellation:Promise<void>|undefined;
 const f=await fixture({focused:true,plan(input,mutate){
  const action:BrowserAction={type:'submit_search',ref:input.observation.elements[0]!.ref};
  switch(scenario){
   case 'changed-document':mutate({documentId:'doc-b'});break;
   case 'missing-document':mutate({documentId:undefined});break;
   case 'changed-view':mutate({observationMode:undefined,readingViewport:{documentId:'doc-a',scrollY:0,height:800,scrollHeight:800,text:'same id different view'}});break;
   case 'changed-url':mutate({url:'https://www.naver.com/other'});break;
   case 'changed-profile':mutate({profileId:'foreign'});break;
   case 'changed-tab':mutate({tabId:'foreign'});break;
   case 'cancel':case 'endless':mutate();break;
  }
  return {thought:'Original focused proposal',action};
 },execute(){if(scenario==='unknown-outcome')throw Error('Browser context changed');},onChange(snapshot,runtime){const job=snapshot.jobs[0];if(scenario==='cancel'&&!cancellation&&job?.events.some(isDiscard))cancellation=runtime.cancel(job.id);}});
 try{const job=await f.run();await cancellation;
  if(scenario==='unknown-outcome'){assert.equal(job.status,'unknown');assert.equal(f.executed.length,1);assert.equal(f.plans.length,1);assert.equal(job.events.filter(isDiscard).length,0);}
  else if(scenario==='endless'){assert.equal(job.status,'failed');assert.equal(f.plans.length,3);assert.equal(job.events.filter(isDiscard).length,2);assert.equal(f.executed.length,0);assert.equal(job.steps,3);}
  else {assert.equal(job.status,scenario==='cancel'?'cancelled':'failed');assert.equal(f.plans.length,1);assert.equal(f.executed.length,0);assert.equal(job.events.filter(isDiscard).length,scenario==='cancel'?1:0);}
 }finally{await f.close();}
});

test('full view cannot acquire focused identity during a stale replan',async()=>{
 const f=await fixture({plan(input,mutate){mutate({observationMode:'search-form',documentId:'doc-a',readingViewport:undefined});return {thought:'Old full proposal',action:{type:'fill',ref:input.observation.elements[0]!.ref,value:'public'}};}});
 try{const job=await f.run();assert.equal(job.status,'failed');assert.equal(f.plans.length,1);assert.equal(f.executed.length,0);assert.equal(job.events.filter(isDiscard).length,0);}finally{await f.close();}
});

test('same-document DOM drift discards old ref and plans again using the fresh target', async () => {
  let decided = false;
  const f = await fixture({ plan(input, mutate) {
    if (!decided) {
      decided = true;
      const proposal: PlanStep = { thought: 'Fill observed original field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'public query' } };
      mutate(); // Replace r1 with r2 AFTER deciding the stale proposal, within doc-a.
      return proposal;
    }
    if (input.history.some(event => event.kind === 'action')) return done;
    return { thought: 'Decide anew on replacement field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'fresh query' } };
  } });
  try {
    const job = await f.run();
    assert.equal(f.plans[0]!.observation.elements[0]!.ref, 'r1');
    assert.equal(f.executed.some(item => 'ref' in item.action && item.action.ref === 'r1'), false);
    assert.equal(job.events.some(event => event.kind === 'error' && !event.text.includes('authorize:stale-document')), false);
    assert.equal(job.status, 'completed');
    assert.equal(f.plans.length, 3);
    assert.equal(f.plans[1]!.observation.revision, 2);
    assert.deepEqual(f.plans[1]!.observation.elements.map(element => element.ref), ['r2']);
    assert.deepEqual(f.executed.map(item => item.action), [{ type: 'fill', ref: 'r2', value: 'fresh query' }]);
    assert.equal(f.executed[0]!.context.expectedRevision, 2);
    assert.equal(job.steps, 3);
    assert.equal(job.events.filter(isDiscard).length, 1);
    assert.equal(job.events.filter(event => event.kind === 'action').length, 1);
    assert.equal(job.events.filter(event => event.kind === 'error').length, 0);
    assert.equal(job.approval, null);
  } finally { await f.close(); }
});

for (const scenario of ['replacement document', 'legacy task', 'missing document identity', 'changed exact URL', 'unchanged revision target replacement'] as const) {
  test(`${scenario} never replans a stale proposal`, async () => {
    const f = await fixture({ legacy: scenario === 'legacy task', plan(input, mutate) {
      const proposal: PlanStep = { thought: 'Fill original observed field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } };
      switch (scenario) {
        case 'replacement document': mutate({ readingViewport: { ...input.observation.readingViewport!, documentId: 'doc-b' } }); break;
        case 'missing document identity': mutate({ readingViewport: undefined }); break;
        case 'changed exact URL': mutate({ url: 'https://example.com/other' }); break;
        case 'unchanged revision target replacement': mutate({ revision: input.observation.revision }); break;
        case 'legacy task': mutate(); break;
      }
      return proposal;
    } });
    try {
      const job = await f.run();
      assert.equal(job.status, 'failed');
      assert.equal(f.plans.length, 1);
      assert.equal(f.executed.length, 0);
      assert.equal(job.events.filter(isDiscard).length, 0);
      assert.equal(job.events.filter(event => event.kind === 'action').length, 0);
    } finally { await f.close(); }
  });
}

for (const legacy of [false,true]) test(`read-only observe drift ${legacy?'keeps legacy binding':'replans only inside the same goal document'}`, async()=>{
  let changed=false;
  const f=await fixture({legacy,plan(_input,mutate){
    if(changed)return done;
    changed=true;mutate();return {thought:'Observe loading search results again',action:{type:'observe'}};
  }});
  try{
    const job=await f.run();
    assert.equal(job.status,legacy?'failed':'completed');
    assert.equal(f.plans.length,legacy?1:2);
    assert.equal(f.executed.length,0);
    assert.equal(job.events.filter(isDiscard).length,legacy?0:1);
  }finally{await f.close();}
});

test('endless DOM drift consumes only two replans and never executes', async () => {
  const f = await fixture({ plan(input, mutate) {
    const proposal: PlanStep = { thought: 'Use observed field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } };
    mutate();
    return proposal;
  } });
  try {
    const job = await f.run();
    assert.equal(job.status, 'failed');
    assert.equal(f.plans.length, 3);
    assert.equal(job.steps, 3);
    assert.deepEqual(f.plans.map(input => input.observation.revision), [1, 2, 3]);
    assert.equal(f.executed.length, 0);
    assert.equal(job.events.filter(isDiscard).length, 2);
    assert.equal(job.events.filter(event => event.kind === 'action').length, 0);
    assert(job.events.some(event => event.kind === 'error' && event.text.includes('authorize:stale-document')));
  } finally { await f.close(); }
});

test('successful owned navigation gives the new document its own bounded replan budget', async () => {
  const changed = new Map<string,number>();
  const f = await fixture({
    plan(input, mutate) {
      const id = input.observation.readingViewport!.documentId;
      const proposal: PlanStep = { thought: 'Fill current observed search field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } };
      if ((changed.get(id) ?? 0) < 2) { changed.set(id, (changed.get(id) ?? 0) + 1); mutate(); return proposal; }
      const fills = input.history.filter(e => e.kind === 'action' && e.text === 'fill').length;
      if (id === 'doc-a' && fills === 1) return { thought: 'Navigate to task result', action: { type: 'navigate', url: 'https://example.com/results' } };
      return id === 'doc-b' && fills === 2 ? done : proposal;
    },
    execute(mutate, action) {
      if (action.type === 'navigate') mutate({ url: action.url, readingViewport: { documentId: 'doc-b', scrollY: 0, height: 800, scrollHeight: 800, text: 'Result document' } });
    },
  });
  try {
    const job = await f.run();
    assert(f.executed.some(e => e.action.type === 'navigate'), 'The authorized new-document transition must actually occur');
    assert(f.plans.some(p => p.observation.readingViewport?.documentId === 'doc-b'), 'The new result document must reach planning');
    assert.equal(job.status, 'completed');
    assert.equal(job.steps, 8);
    assert.equal(f.plans.length, 8);
    assert.deepEqual(f.executed.map(e => e.action.type), ['fill','navigate','fill']);
    assert.equal(job.events.filter(isDiscard).length, 4);
    assert.equal(job.events.filter(e => e.kind === 'error').length, 0);
  } finally { await f.close(); }
});

test('discard still consumes the existing model step budget', async () => {
  const f = await fixture({ plan(input, mutate) {
    const proposal: PlanStep = { thought: 'Use observed field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } };
    mutate(); return proposal;
  } });
  try {
    await f.runtime.updateSettings({ maxSteps: 1 });
    const job = await f.run();
    assert.equal(job.status, 'failed');
    assert.equal(job.steps, 1);
    assert.equal(f.plans.length, 1);
    assert.equal(f.executed.length, 0);
    assert.equal(job.events.filter(isDiscard).length, 1);
  } finally { await f.close(); }
});

test('post-dispatch stale-document failure remains unknown without replanning', async () => {
  const f = await fixture({
    plan: input => ({ thought: 'Use current field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } }),
    execute() { throw new Error('Browser context changed'); },
  });
  try {
    const job = await f.run();
    assert.equal(job.status, 'unknown');
    assert.equal(f.plans.length, 1);
    assert.equal(f.executed.length, 1);
    assert.equal(job.events.filter(isDiscard).length, 0);
    assert.equal(job.events.filter(event => event.kind === 'action').length, 1);
    assert(job.events.some(event => event.kind === 'error' && event.text.includes('execute:stale-document')));
  } finally { await f.close(); }
});

test('cancellation on discard publication prevents another model call or execution', async () => {
  let cancellation: Promise<void> | undefined;
  const f = await fixture({
    plan(input, mutate) {
      const proposal: PlanStep = { thought: 'Use observed field', action: { type: 'fill', ref: input.observation.elements[0]!.ref, value: 'query' } };
      mutate(); return proposal;
    },
    onChange(snapshot, runtime) {
      const job = snapshot.jobs[0];
      if (!cancellation && job?.events.some(isDiscard)) cancellation = runtime.cancel(job.id);
    },
  });
  try {
    const job = await f.run();
    await cancellation;
    assert(cancellation, 'Cancellation must occur at discard, not some earlier fixture phase');
    assert.equal(job.status, 'cancelled');
    assert.equal(f.plans.length, 1);
    assert.equal(f.executed.length, 0);
    assert.equal(job.steps, 1);
    assert.equal(job.events.filter(isDiscard).length, 1);
    assert.equal(job.events.filter(event => event.kind === 'action').length, 0);
    assert.equal(f.runtime.snapshot().activeJobId, null);
  } finally { await f.close(); }
});

test('manual authorization is never transferred to a new DOM revision', async () => {
  let approved: Promise<void> | undefined;
  let approvalObservation = false;
  let mutateBeforeDispatch = false;
  const f = await fixture({
    beforeObserve(mutate) {
      if (approvalObservation) { approvalObservation = false; mutateBeforeDispatch = true; }
      else if (mutateBeforeDispatch) { mutateBeforeDispatch = false; mutate(); }
    },
    plan: input => ({ thought: 'Request manual control', action: { type: 'click', ref: input.observation.elements[0]!.ref } }),
    onChange(snapshot, runtime) {
      const job = snapshot.jobs[0];
      // Clicking a search textbox is not an automatic local/navigation/search control.
      if (!approved && job?.approval) {
        approvalObservation = true;
        approved = runtime.approve({ jobId: job.id, approvalId: job.approval.id, allow: true });
      }
    },
  });
  try {
    const job = await f.run();
    await approved;
    assert(approved, 'The manual approval must actually be exercised');
    assert.equal(job.status, 'failed');
    assert.equal(f.plans.length, 1);
    assert.equal(f.executed.length, 0);
    assert.equal(job.events.filter(isDiscard).length, 0);
    assert(job.events.some(event => event.kind === 'error' && event.text.includes('authorize:stale-document')));
  } finally { await f.close(); }
});
