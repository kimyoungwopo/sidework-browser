import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../contract.ts';
import type { BrowserAction, BrowserContext, BrowserPort, CoreSnapshot, Job, JobEvent, PendingApproval, Planner, Observation, Settings, TaskInput, ReadingViewport, PageReadingEvidence } from '../contract.ts';
import { isAutomaticComputerAction } from '../computer-policy.ts';
import { isAutomaticAgentAction } from '../agent-action-policy.ts';
import {goalScopeAllows} from '../goal-navigation';
import { RuntimeStore } from './store.ts';
import { validateAgentScope, validateInitialDocument, validatePlan, validateSettings } from './validation.ts';

interface JobRun { screenBytes?: string; controller: AbortController; running: Promise<void> | null; mutation: boolean; secrets: Set<string>; pending: { jobId: string; approval: PendingApproval; observation: Observation; resolve: (allow: boolean) => void } | null }
interface ScrollCohort { members: Set<string>; ready: Map<string, () => void>; originalSize: number; timer?: ReturnType<typeof setTimeout> }
const mutations = new Set(['navigate', 'open_tab', 'click', 'submit_search', 'fill', 'computer_click', 'computer_type', 'computer_key']);
export class AgentRuntime {
  private state: CoreSnapshot = { jobs: [], activeJobId: null, settings: { ...DEFAULT_SETTINGS }, memory: [] };
  private readonly store: RuntimeStore;
  private readonly browser: BrowserPort;
  private readonly planner: Planner;
  private readonly onChange: (snapshot: CoreSnapshot) => void;
  private runs = new Map<string, JobRun>();
  private tasks = new Set<Promise<void>>();
  private cohorts = new Map<string, ScrollCohort>();
  private readonly syncTimeoutMs: number;
  private closed = false;
  constructor(options: { store: RuntimeStore; browser: BrowserPort; planner: Planner; onChange: (snapshot: CoreSnapshot) => void; syncTimeoutMs?: number }) {
    this.syncTimeoutMs = options.syncTimeoutMs ?? 40_000;
    if (!Number.isFinite(this.syncTimeoutMs) || this.syncTimeoutMs < 1 || this.syncTimeoutMs > 40_000) throw new Error('Invalid first-scroll timeout');
    this.store = options.store; this.browser = options.browser; this.planner = options.planner; this.onChange = options.onChange;
  }
  async initialize(): Promise<void> {
    this.state = await this.store.load();
    this.state.activeJobId = null;
    this.state.activeJobIds = [];
    for (const job of this.state.jobs) {
      job.approval = null;
      if (['queued', 'running', 'awaiting_approval'].includes(job.status)) {
        job.status = 'interrupted'; job.answer = null; job.error = 'Task interrupted by restart. It was not resumed.';
        this.event(job, 'status', job.error);
      }
    }
    await this.publish();
  }
  snapshot(): CoreSnapshot { return structuredClone(this.state); }
  private storageFailed = false;
  private publications: Promise<void> = Promise.resolve();
  private async publish(): Promise<void> {
    const snapshot = this.snapshot();
    const publication = this.publications.then(async () => {
      if (this.storageFailed) throw new Error('Local runtime data could not be saved; execution stopped.');
      try { await this.store.save(snapshot); }
      catch {
        this.storageFailed = true; this.closed = true;
        for (const [id, run] of this.runs) {
          const job = this.state.jobs.find(job => job.id === id)!;
          job.status = run.mutation ? 'unknown' : 'failed';
          job.answer = null; job.approval = null;
          job.error = 'Local runtime data could not be saved; execution stopped.';
          run.controller.abort(); run.pending?.resolve(false); run.pending = null;
        }
        this.runs.clear(); this.syncActive();
        this.onChange(this.snapshot());
        throw new Error('Local runtime data could not be saved; execution stopped.');
      }
      this.onChange(snapshot);
    });
    this.publications = publication.catch(() => undefined);
    return publication;
  }
  private syncActive(): void { this.state.activeJobIds = [...this.runs.keys()]; this.state.activeJobId = this.state.activeJobIds[0] ?? null; }
  private sanitize(text: string, job: Job, max = 1000): string {
    const pixels = this.runs.get(job.id)?.screenBytes;
    let safe = pixels ? text.split(pixels).join('[image redacted]') : text;
    for (const secret of this.runs.get(job.id)?.secrets ?? []) safe = safe.split(secret).join('[redacted]');
    return safe.replace(/(?:bearer\s+)[^\s]+/gi, 'Bearer [redacted]')
      .replace(/((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .split('').filter(character => { const code = character.charCodeAt(0); return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127); }).join('').slice(0, max);
  }
  private event(job: Job, kind: JobEvent['kind'], text: string): void {
    job.events.push({ id: randomUUID(), at: new Date().toISOString(), kind, text: this.sanitize(text, job) });
    job.events = job.events.slice(-200);
    job.updatedAt = new Date().toISOString();
  }
  async start(input: TaskInput): Promise<string> {
    if (this.closed) throw new Error('Runtime is closed after shutdown');
    if (this.runs.size >= 8) throw new Error('Runtime busy: eight job limit');
    if ([...this.runs.keys()].some(id => { const j = this.state.jobs.find(j => j.id === id)!; return j.profileId === input?.profileId && j.tabId === input?.tabId; })) throw new Error('Runtime busy: duplicate tab');
    this.validateInput(input);
    const now = new Date().toISOString();
    const job: Job = { id: randomUUID(), ...structuredClone(input), status: 'running', createdAt: now, updatedAt: now, events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
    const run: JobRun = { controller: new AbortController(), running: null, mutation: false, secrets: new Set(), pending: null };
    this.runs.set(job.id, run);
    this.state.jobs.unshift(job); this.syncActive();
    try { await this.publish(); }
    catch {
      job.status = 'failed'; job.error = 'Local runtime data could not be saved; execution stopped.';
      this.runs.delete(job.id); this.syncActive(); this.closed = true;
      this.onChange(this.snapshot());
      throw new Error(job.error);
    }
    if (job.status === 'running') {
      run.running = this.run(job, run);
      this.tasks.add(run.running);
      void run.running.finally(() => this.tasks.delete(run.running!));
    }
    return job.id;
  }
  private validateInput(input: TaskInput): void {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 || typeof input.profileId !== 'string' || !input.profileId.trim() || input.profileId.length > 256 || typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > 256) throw new Error('Invalid task input');
    if (Object.keys(input).some(key => !['prompt', 'profileId', 'tabId', 'computerUse', 'shareScreen', 'initialDocument', 'executionEpoch', 'agentScope'].includes(key)) || ('computerUse' in input && typeof input.computerUse !== 'boolean') || ('shareScreen' in input && typeof input.shareScreen !== 'boolean')) throw new Error('Invalid task input');
    if ('agentScope' in input) {
      validateAgentScope(input.agentScope);
      const remaining=Date.parse(input.agentScope!.expiresAt)-Date.now();
      if(remaining<=0 || remaining>60*60*1000) throw new Error('Agent task scope expired or unbounded');
    }
    if ('executionEpoch' in input && (!Number.isSafeInteger(input.executionEpoch)||input.executionEpoch!<0)) throw new Error('Invalid task execution epoch');
    if ('initialDocument' in input) validateInitialDocument(input.initialDocument);
    if(input.initialDocument?.documentId!==undefined&&!input.agentScope?.goalId)throw new Error('Document-instance startup requires a main-owned goal scope');
    if (input.computerUse && input.shareScreen !== true) throw new Error('Computer use requires explicit screen sharing consent');
  }
  async startBatch(inputs: TaskInput[]): Promise<string[]> {
    if (this.closed) throw new Error('Runtime is closed after shutdown');
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 8) throw new Error('Invalid independent batch size');
    if (this.runs.size + inputs.length > 8) throw new Error('Runtime busy: eight job limit');
    const tabs = new Set<string>();
    for (const input of inputs) {
      this.validateInput(input);
      if (input.profileId !== inputs[0]!.profileId) throw new Error('Independent batch requires one profile');
      if (tabs.has(input.tabId) || [...this.runs.keys()].some(id => {
        const job = this.state.jobs.find(job => job.id === id)!;
        return job.profileId === input.profileId && job.tabId === input.tabId;
      })) throw new Error('Runtime busy: duplicate tab');
      tabs.add(input.tabId);
    }
    const members = inputs.map(input => {
      const now = new Date().toISOString();
      const job: Job = { ...structuredClone(input), id: randomUUID(), status: 'running', createdAt: now, updatedAt: now, events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
      const run: JobRun = { controller: new AbortController(), running: null, mutation: false, secrets: new Set(), pending: null };
      this.runs.set(job.id, run); this.state.jobs.unshift(job);
      return { job, run };
    });
    this.syncActive();
    try { await this.publish(); }
    catch (error) {
      const ids = new Set(members.map(({ job }) => job.id));
      for (const { job, run } of members) { run.controller.abort(); this.runs.delete(job.id); }
      this.state.jobs = this.state.jobs.filter(job => !ids.has(job.id));
      this.syncActive();
      if (!this.storageFailed) await this.publish();
      else this.onChange(this.snapshot());
      throw error;
    }
    for (const { job, run } of members) {
      if (job.status !== 'running' || run.controller.signal.aborted) continue;
      run.running = this.run(job, run);
      this.tasks.add(run.running);
      void run.running.finally(() => this.tasks.delete(run.running!));
    }
    return members.map(({ job }) => job.id);
  }
  async startTogether(inputs: TaskInput[]): Promise<string[]> {
    if (this.closed) throw new Error('Runtime is closed after shutdown');
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 8) throw new Error('Invalid synchronized batch size');
    if (this.runs.size + inputs.length > 8) throw new Error('Runtime busy: eight job limit');
    const tabs = new Set<string>();
    for (const input of inputs) {
      this.validateInput(input);
      if (input.computerUse === true || input.agentScope) throw new Error('Synchronized scroll requires non-delegated DOM mode');
      if (input.profileId !== inputs[0]!.profileId) throw new Error('Synchronized batch requires one profile');
      if (tabs.has(input.tabId) || [...this.runs.keys()].some(id => {
        const job = this.state.jobs.find(job => job.id === id)!;
        return job.profileId === input.profileId && job.tabId === input.tabId;
      })) throw new Error('Runtime busy: duplicate tab');
      tabs.add(input.tabId);
    }
    const members = inputs.map(input => {
      const now = new Date().toISOString();
      const job: Job = { ...structuredClone(input), id: randomUUID(), synchronizedScroll: true, status: 'running', createdAt: now, updatedAt: now, events: [], artifacts: [], answer: null, error: null, approval: null, steps: 0 };
      const run: JobRun = { controller: new AbortController(), running: null, mutation: false, secrets: new Set(), pending: null };
      this.runs.set(job.id, run); this.state.jobs.unshift(job);
      return { job, run };
    });
    const cohort: ScrollCohort = { members: new Set(members.map(({ job }) => job.id)), ready: new Map(), originalSize: members.length };
    for (const { job } of members) this.cohorts.set(job.id, cohort);
    cohort.timer = setTimeout(() => this.expireScroll(cohort), this.syncTimeoutMs);
    this.syncActive();
    try { await this.publish(); }
    catch (error) {
      for (const { job, run } of members) {
        this.withdrawScroll(job.id);
        run.controller.abort(); this.runs.delete(job.id);
      }
      this.state.jobs = this.state.jobs.filter(job => !members.some(member => member.job.id === job.id));
      this.syncActive();
      if (!this.storageFailed) await this.publish();
      else this.onChange(this.snapshot());
      throw error;
    }
    for (const { job, run } of members) {
      if (job.status !== 'running' || run.controller.signal.aborted) continue;
      run.running = this.run(job, run);
      this.tasks.add(run.running);
      void run.running.finally(() => this.tasks.delete(run.running!));
    }
    return members.map(({ job }) => job.id);
  }
  private releaseScroll(cohort: ScrollCohort): void {
    if (cohort.ready.size !== cohort.members.size) return;
    clearTimeout(cohort.timer);
    for (const id of cohort.members) {
      this.cohorts.delete(id);
      const job = this.state.jobs.find(job => job.id === id)!;
      this.event(job, 'status', `First scroll released: ${cohort.members.size}/${cohort.originalSize} members prepared; release is not execution success.`);
    }
    for (const resolve of cohort.ready.values()) resolve();
    cohort.members.clear(); cohort.ready.clear();
  }
  private expireScroll(cohort: ScrollCohort): void {
    const ids = [...cohort.members];
    clearTimeout(cohort.timer);
    for (const id of ids) this.cohorts.delete(id);
    cohort.members.clear(); cohort.ready.clear();
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run) continue;
      const job = this.state.jobs.find(job => job.id === id)!;
      this.event(job, 'status', 'First-scroll cohort timed out; no synchronized release occurred.');
      job.status = 'failed'; job.answer = null; job.approval = null;
      job.error = 'First-scroll cohort timed out.';
      run.controller.abort();
      this.runs.delete(id);
    }
    this.syncActive();
    void this.publish().catch(() => undefined);
  }
  private withdrawScroll(id: string): void {
    const cohort = this.cohorts.get(id);
    if (!cohort) return;
    this.cohorts.delete(id); cohort.members.delete(id); cohort.ready.delete(id);
    const job = this.state.jobs.find(job => job.id === id)!;
    this.event(job, 'status', 'Withdrawn from first-scroll cohort; not counted as a synchronized scroll.');
    this.releaseScroll(cohort);
  }
  private async firstScroll(job: Job, isScroll: boolean, signal: AbortSignal): Promise<boolean> {
    const cohort = this.cohorts.get(job.id);
    if (!cohort) return false;
    if (!isScroll) { this.withdrawScroll(job.id); return false; }
    this.event(job, 'status', 'First scroll prepared; waiting for cohort plans.');
    await this.publish();
    signal.throwIfAborted();
    const wait = new Promise<void>(resolve => { cohort.ready.set(job.id, resolve); });
    this.releaseScroll(cohort);
    await this.abortable(wait, signal);
    return true;
  }
  private async observe(job: Job, context: BrowserContext): Promise<Observation> {
    const observation = await this.browser.observe(context, {jobId:job.id,...job.computerUse ? { computerUse: true, shareScreen: job.shareScreen } : {}});
    const run = this.runs.get(job.id);
    if (run && observation.screen?.pngBase64) run.screenBytes = observation.screen.pngBase64;
    if (!job.computerUse) { const copy = { ...observation }; delete copy.screen; return copy; }
    return observation;
  }
  private digest(action: BrowserAction, context: BrowserContext, revision: number): string {
    return createHash('sha256').update(JSON.stringify({ action, context, revision })).digest('hex');
  }
  async approve(input: { jobId: string; approvalId: string; allow: boolean }): Promise<void> {
    const run = this.runs.get(input.jobId);
    const pending = run?.pending;
    if (!pending || pending.jobId !== input.jobId || pending.approval.id !== input.approvalId) throw new Error('Approval is no longer valid');
    const signal = run?.controller.signal;
    if (!signal) throw new Error('Approval is no longer valid');
    run!.pending = null;
    try {
      signal.throwIfAborted();
      if (this.state.settings.permissionMode === 'read-only') throw new Error('Read-only mode denies approval');
      if (Date.now() >= Date.parse(pending.approval.expiresAt)) throw new Error('Approval expired');
      if (pending.approval.digest !== this.digest(pending.approval.action, pending.approval.context, pending.approval.revision)) throw new Error('Approval digest changed');
      if (input.allow) {
        const fresh = await this.abortable(this.observe(this.state.jobs.find(j => j.id === input.jobId)!, pending.approval.context), signal);
        this.compare(pending.observation, fresh, pending.approval.action);
        if (Date.now() >= Date.parse(pending.approval.expiresAt)) throw new Error('Approval expired');
      }
      pending.resolve(input.allow);
    } catch { pending.resolve(false); throw new Error('Approval expired or browser context/target changed'); }
  }
  private compare(before: Observation, after: Observation, action: BrowserAction): void {
    if (before.profileId !== after.profileId || before.tabId !== after.tabId || before.revision !== after.revision || before.url !== after.url) throw new Error('Browser context changed');
    if ('frameId' in action) {
      const a = before.screen, b = after.screen;
      if (!a || !b || a.frameId !== action.frameId || b.frameId !== action.frameId || a.width !== b.width || a.height !== b.height || a.viewportWidth !== b.viewportWidth || a.viewportHeight !== b.viewportHeight || a.pngBase64 !== b.pngBase64 || JSON.stringify(a.safeLinks) !== JSON.stringify(b.safeLinks)) throw new Error('Computer frame changed');
      if (action.type === 'computer_click' && (action.x >= a.width || action.y >= a.height)) throw new Error('Computer coordinates outside frame');
    }
    if (action.type === 'click' || action.type === 'fill' || action.type === 'submit_search') {
      const target = before.elements.find(element => element.ref === action.ref);
      const fresh = after.elements.find(element => element.ref === action.ref);
      if (!target || !fresh || JSON.stringify(target) !== JSON.stringify(fresh) || (action.type === 'fill' && fresh.sensitive)) throw new Error('Browser target changed or sensitive');
    }
  }
  private async permission(job: Job, action: BrowserAction, context: BrowserContext, observation: Observation): Promise<PendingApproval> {
    const revision = observation.revision;
    const approval: PendingApproval = { id: randomUUID(), action: structuredClone(action), context: { ...context }, revision, digest: this.digest(action, context, revision), expiresAt: new Date(Date.now() + 60_000).toISOString(), summary: action.type === 'fill' ? `fill ${action.ref} (value hidden)` : action.type === 'computer_type' ? 'computer_type (value hidden)' : action.type };
    job.approval = structuredClone(approval);
    if (job.approval.action.type === 'fill' || job.approval.action.type === 'computer_type') job.approval.action.value = '[redacted]';
    job.status = 'awaiting_approval';
    let resolve: (allow: boolean) => void = () => undefined;
    const wait = new Promise<boolean>(done => { resolve = done; });
    const run = this.runs.get(job.id)!;
    run.pending = { jobId: job.id, approval: structuredClone(approval), observation: structuredClone(observation), resolve };
    const timer = setTimeout(() => {
      if (run.pending?.approval.id === approval.id) run.pending = null;
      resolve(false);
    }, 60_000);
    let allowed: boolean;
    try { await this.publish(); allowed = await this.abortable(wait, run.controller.signal); }
    finally { clearTimeout(timer); }
    job.approval = null;
    run.controller.signal.throwIfAborted();
    job.status = 'running';
    if (!allowed) throw new Error('Approval denied');
    return approval;
  }
  private async abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Cancelled')); signal.addEventListener('abort', abort, { once: true }); });
    try { const result = await Promise.race([operation, cancelled]); signal.throwIfAborted(); return result; }
    finally { signal.removeEventListener('abort', abort); }
  }
  private readingViewport(observation: Observation): ReadingViewport {
    const view = observation.readingViewport;
    if (!view || typeof view.documentId !== 'string' || !view.documentId.trim() || view.documentId.length > 200 || typeof view.text !== 'string' || view.text.length > 12000 || !view.text.trim() || ![view.scrollY, view.height, view.scrollHeight].every(Number.isFinite) || view.scrollY < 0 || view.height < 600 || view.scrollHeight < view.height || view.scrollY > view.scrollHeight - view.height + 1) throw new Error('Reading viewport unavailable');
    return view;
  }
  private assertAgentDocument(job:Job,observation:Observation):void {
    if(!job.agentScope)return;
    validateAgentScope(job.agentScope);
    if(Date.now()>=Date.parse(job.agentScope.expiresAt) || observation.profileId!==job.profileId || observation.tabId!==job.tabId || !goalScopeAllows(job.agentScope,observation.url))throw new Error('Agent task scope changed or expired');
  }
  private assertReadingDocument(evidence: PageReadingEvidence, observation: Observation): ReadingViewport {
    const viewport = this.readingViewport(observation);
    if (observation.profileId !== evidence.profileId || observation.tabId !== evidence.tabId || observation.url !== evidence.url || viewport.documentId !== evidence.documentId) throw new Error('Browser context changed');
    return viewport;
  }
  /** Bounded, read-only host loop; every scroll retains its own native revision/authority check. */
  private async readPage(job: Job, context: BrowserContext, initial: Observation, maxScreens: number, signal: AbortSignal): Promise<PageReadingEvidence> {
    const anchor = this.readingViewport(initial);
    const evidence: PageReadingEvidence = { ...context, url: initial.url, documentId: anchor.documentId, sections: [], complete: false, stopReason: 'limit' };
    let observation = initial;
    const limit = Math.min(maxScreens, this.state.settings.maxSteps - job.steps + 1);
    const action: BrowserAction = { type: 'scroll', direction: 'down' };
    for (let index = 0; index < limit; index++) {
      signal.throwIfAborted();
      const fresh = await this.abortable(this.observe(job, context), signal);
      this.assertAgentDocument(job,fresh);
      this.compare(observation, fresh, action);
      const viewport = this.assertReadingDocument(evidence, fresh);
      evidence.sections.push({ scrollY: viewport.scrollY, text: this.sanitize(viewport.text, job, 12000) });
      const atBottom = viewport.scrollY + viewport.height >= viewport.scrollHeight - 1;
      evidence.complete = atBottom; evidence.stopReason = atBottom ? 'bottom' : 'limit';
      this.event(job, 'status', `본문 수집 ${evidence.sections.length}/${limit}화면${atBottom ? ' · 문서 하단 도달' : ''}`);
      await this.publish(); signal.throwIfAborted();
      if (atBottom || index + 1 >= limit || job.steps >= this.state.settings.maxSteps) break;
      job.steps++;
      this.event(job, 'action', 'scroll');
      await this.publish(); signal.throwIfAborted();
      const result = await this.abortable(this.browser.execute(action, { ...context, jobId: job.id, expectedRevision: fresh.revision }), signal);
      if (result.context.profileId !== context.profileId || result.context.tabId !== context.tabId) throw new Error('Browser context changed');
      observation = await this.abortable(this.observe(job, context), signal);
      const after = this.assertReadingDocument(evidence, observation);
      if (after.scrollY <= viewport.scrollY) throw new Error('Reading scroll made no progress');
    }
    return evidence;
  }
  private async run(job: Job, run: JobRun): Promise<void> {
    const signal = run.controller.signal;
    let phase='observe';
    try {
      let context: BrowserContext = { profileId: job.profileId, tabId: job.tabId };
      let pageReading: PageReadingEvidence | undefined;
      const domReplans = new Map<string, number>();
      for (let index = 0; index < this.state.settings.maxSteps && job.steps < this.state.settings.maxSteps; index++) {
        signal.throwIfAborted();
        phase='observe';
        const observation = await this.abortable(this.observe(job, context), signal);
        this.assertAgentDocument(job,observation);
        if (observation.profileId !== context.profileId || observation.tabId !== context.tabId) throw new Error('Wrong browser context');
        if (index === 0 && job.initialDocument && (observation.url !== job.initialDocument.url || (job.initialDocument.documentId!==undefined ? (!job.agentScope?.goalId||(observation.readingViewport?.documentId ?? (observation.observationMode==='search-form'?observation.documentId:undefined))!==job.initialDocument.documentId) : observation.revision !== job.initialDocument.revision))) throw new Error('Browser context changed');
        if (pageReading) this.assertReadingDocument(pageReading, observation);
        this.event(job, 'observation', observation.text);
        phase='plan';
        const step = validatePlan(await this.abortable(this.planner.next({ prompt: job.prompt, observation, history: structuredClone(job.events), settings: structuredClone(this.state.settings), memory: this.state.settings.memoryEnabled ? structuredClone(this.state.memory) : [], signal, computerUse: job.computerUse, jobId: job.id, agentAutomation:!!job.agentScope, ...(pageReading ? { pageReading: structuredClone(pageReading) } : {}), ...(index === 0 && this.cohorts.has(job.id) ? { synchronizeFirstScroll: true } : {}) }), signal));
        this.assertAgentDocument(job,observation);
        const smoothScroll = index === 0 && await this.firstScroll(job, step.action.type === 'scroll', signal);
        if ((step.action.type === 'fill' || step.action.type === 'computer_type') && step.action.value) {
          run.secrets.add(step.action.value);
          for (const event of job.events) event.text = this.sanitize(event.text, job);
        }
        job.steps++;
        this.event(job, 'thought', step.thought);
        if (step.action.type === 'finish') { job.answer = this.sanitize(step.action.text, job, 16000); job.status = 'completed'; break; }
        if (step.action.type === 'read_page') {
          phase = 'read-page';
          pageReading = await this.readPage(job, context, observation, step.action.maxScreens, signal);
          continue;
        }
        const action = step.action;
        if (('frameId' in action && !job.computerUse) || (job.computerUse && action.type === 'open_tab')) throw new Error('Computer capability denied');
        this.compare(observation, observation, action);
        let authorization: PendingApproval | null = null;
        phase='authorize';
        if (mutations.has(action.type)) {
          if (this.state.settings.permissionMode === 'read-only') throw new Error('Read-only mode denies mutation');
          const automatic=job.agentScope ? isAutomaticAgentAction(action,observation,job.agentScope) : job.computerUse && isAutomaticComputerAction(action,observation);
          if(action.type==='submit_search' && (!automatic || !job.agentScope?.goalId || job.computerUse || job.shareScreen))throw new Error('Native search submission capability denied');
          if (!automatic) authorization = await this.permission(job, action, context, observation);
        }
        const fresh = await this.abortable(this.observe(job, context), signal);
        this.assertAgentDocument(job,fresh);
        try {
          this.compare(observation, fresh, action);
        } catch (error) {
          // Only discard an undispatched DOM proposal in the same goal-owned document.
          // The old action is never rebound to the new revision: the planner must decide anew.
          const sameView=observation.observationMode===fresh.observationMode;
          const documentId=observation.observationMode==='search-form'?observation.documentId:observation.readingViewport?.documentId;
          const freshDocumentId=fresh.observationMode==='search-form'?fresh.documentId:fresh.readingViewport?.documentId;
          const replans = typeof documentId === 'string' ? domReplans.get(documentId) ?? 0 : 0;
          if (!(error instanceof Error && error.message === 'Browser context changed'
            && job.agentScope?.goalId && !job.computerUse
            && ['observe', 'fill', 'click', 'scroll', 'submit_search'].includes(action.type)
            && !authorization && !run.pending && !run.mutation && replans < 2
            && observation.profileId === fresh.profileId && observation.tabId === fresh.tabId
            && observation.url === fresh.url && observation.revision !== fresh.revision
            && typeof documentId === 'string' && documentId.trim().length > 0
            && sameView && documentId === freshDocumentId)) throw error;
          domReplans.set(documentId, replans + 1);
          this.event(job, 'status', `같은 문서의 DOM이 변경되어 실행 전 계획을 폐기했습니다. 새 관찰로 다시 계획합니다 (현재 문서 ${replans + 1}/2). 이 계획의 동작은 실행하지 않았습니다.`);
          await this.publish();
          signal.throwIfAborted();
          continue;
        }
        signal.throwIfAborted();
        this.event(job, 'action', action.type);
        await this.publish();
        signal.throwIfAborted();
        if (authorization && (Date.now() >= Date.parse(authorization.expiresAt) || authorization.digest !== this.digest(action, context, fresh.revision))) throw new Error('Approval expired or changed');
        if (mutations.has(action.type) && this.state.settings.permissionMode === 'read-only') throw new Error('Read-only mode denies mutation');
        this.assertAgentDocument(job,fresh);
        if (mutations.has(action.type)) run.mutation = true;
        phase='execute';
        const result = await this.abortable(this.browser.execute(action, { ...context, expectedRevision: fresh.revision, jobId: job.id, ...(smoothScroll ? { smoothScroll: true } : {}) }), signal);
        if (job.computerUse && (result.context.profileId !== job.profileId || result.context.tabId !== job.tabId)) throw new Error('Computer job target changed');
        context = { profileId: result.context.profileId, tabId: result.context.tabId };
        if (action.type === 'navigate' || action.type === 'open_tab' || action.type === 'submit_search') pageReading = undefined;
        if (result.artifact) job.artifacts.push(result.artifact);
        const after = await this.abortable(this.observe(job, context), signal);
        this.event(job, 'observation', after.text);
        run.mutation = false;
        await this.publish();
      }
      if (job.status !== 'completed') throw new Error('Step limit reached');
    } catch (error) {
      const codes:Record<string,string>={'Invalid screen PNG image/frame bounds.':'invalid-screen-frame','Browser context changed':'stale-document','Computer frame changed':'stale-frame','Stale DOM revision':'stale-document','Sensitive or unknown page capture prohibited':'sensitive-capture-blocked'};
      const code=error instanceof Error?(codes[error.message]??(error instanceof TypeError?'type-error':error instanceof RangeError?'range-error':'blocked')):'blocked';
      const location=error instanceof Error?error.stack?.split('\n').slice(1).map(line=>line.match(/\/(worker\.cjs|runtime\.ts|codex\.ts|screen\.ts):(\d+):(\d+)/)?.slice(1).join(':')).filter(Boolean).slice(0,4).join(' <- '):undefined;
      this.event(job,'error',`실행 중단 (${phase}:${code}${location?` · ${location}`:''}). 자동 재실행하지 않았습니다.`);
      if(error instanceof Error&&['Browser context changed','Stale DOM revision'].includes(error.message))this.event(job,'status','실행 전 페이지가 변경되어 오래된 계획을 차단했습니다. 자동 재실행하지 않았습니다.');
      if (run.mutation || job.status === 'unknown') { job.status = 'unknown'; job.error = 'Action outcome is unknown. Verify the page before starting another task; no retry was performed.'; }
      else if (job.status !== 'cancelled') { job.status = 'failed'; job.error = 'Task could not be completed'; }
    }
    this.withdrawScroll(job.id);
    run.mutation = false;
    job.approval = null; run.pending = null;
    this.runs.delete(job.id); this.syncActive();
    try { await this.publish(); }
    catch {
      this.closed = true;
      if (job.status !== 'unknown' && job.status !== 'cancelled') job.status = 'failed';
      job.answer = null; job.error = 'Local runtime data could not be saved; execution stopped.';
      this.onChange(this.snapshot());
    }
  }
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const keys = Object.keys(DEFAULT_SETTINGS);
    if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !keys.includes(key))) throw new Error('Invalid settings');
    const next = validateSettings({ ...this.state.settings, ...patch });
    this.state.settings = next;
    await this.publish();
  }
  async addMemory(text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || this.state.memory.length >= 100) throw new Error('Invalid memory note');
    this.state.memory.push({ id: randomUUID(), text: text.trim(), createdAt: new Date().toISOString() });
    await this.publish();
  }
  async removeMemory(id: string): Promise<void> {
    this.state.memory = this.state.memory.filter(entry => entry.id !== id);
    await this.publish();
  }
  async cancel(jobId: string): Promise<void> {
    const job = this.state.jobs.find(item => item.id === jobId);
    if (!job) throw new Error('Job not found');
    const run = this.runs.get(jobId);
    if (!run) return;
    job.status = run.mutation ? 'unknown' : 'cancelled'; job.approval = null;
    run.controller.abort();
    this.withdrawScroll(jobId);
    run.pending?.resolve(false); run.pending = null;
    await run.running;
    this.runs.delete(jobId); this.syncActive();
    await this.publish();
  }
  async cancelAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(id => this.cancel(id)));
    await Promise.all([...this.tasks]);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.cancelAll();
  }
}
