import type { BrowserAction, BrowserActionResult, BrowserContext, BrowserState, Job, PageControlState, TaskInput } from '../contract.js';

function key(context: BrowserContext): string {
  if (!context || typeof context.profileId !== 'string' || !context.profileId.trim() || typeof context.tabId !== 'string' || !context.tabId.trim()) throw new Error('Explicit page identity required');
  return JSON.stringify([context.profileId, context.tabId]);
}

/** Synchronous, per-page authorization. No operations are scheduled here. */
export class PageAuthority {
  private readonly epochs = new Map<string, number>();
  private readonly bindings = new Map<string, { origin: string; epoch: number; pages: Set<string> }>();
  private readonly markers = new Map<string, { context: BrowserContext; generation: number; state: 'reclaiming' | 'user' | 'unknown' }>();
  private generation = 0;

  bindInput(input: TaskInput): TaskInput {
    const origin = key(input);
    if (this.markers.get(origin)?.state === 'reclaiming') throw new Error('Page is reclaiming');
    return { ...structuredClone(input), executionEpoch: this.epochs.get(origin) ?? 0 };
  }

  assertRequest(jobs: readonly Job[], context: BrowserContext, jobId: string, operation: 'observe' | 'execute'): void {
    const target = key(context);
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Job identity required');
    const matches = jobs.filter(job => job.id === jobId);
    if (matches.length !== 1) throw new Error('Unique active job required');
    const job = matches[0];
    const origin = key(job);
    if (job.profileId !== context.profileId || (job.status !== 'running' && !(operation === 'observe' && job.status === 'awaiting_approval'))) throw new Error('Job is not authorized');
    if (typeof job.executionEpoch !== 'number' || !Number.isSafeInteger(job.executionEpoch) || job.executionEpoch !== (this.epochs.get(origin) ?? 0)) throw new Error('Stale execution epoch');
    let binding = this.bindings.get(jobId);
    if (binding && (binding.origin !== origin || binding.epoch !== job.executionEpoch)) throw new Error('Job identity changed');
    if (!binding) {
      binding = { origin, epoch: job.executionEpoch, pages: new Set([origin]) };
      this.bindings.set(jobId, binding);
    }
    if (!binding.pages.has(target)) throw new Error('Page is not authorized');
    if (this.markers.get(target)?.state === 'reclaiming' || this.markers.get(origin)?.state === 'reclaiming') throw new Error('Page is reclaiming');
    if (job.status === 'running') {
      this.markers.delete(target);
      this.markers.delete(origin);
    }
  }

  registerResult(jobs: readonly Job[], context: BrowserContext, jobId: string, action: BrowserAction, result: BrowserActionResult, state: BrowserState): void {
    this.assertRequest(jobs, context, jobId, 'execute');
    const target = key(result.context);
    if (state.activeProfileId !== context.profileId) throw new Error('Inactive result profile');
    if (action.type === 'open_tab' && jobs.find(job => job.id === jobId)?.computerUse) throw new Error('Computer jobs cannot open tabs');
    if (target === key(context)) return;
    if (action.type !== 'open_tab' || result.context.profileId !== context.profileId) throw new Error('Unexpected result page');
    const page = state.tabs.find(tab => tab.id === result.context.tabId && tab.profileId === result.context.profileId);
    if (!page || page.ownership !== 'agent' || page.lifecycle === 'dormant' || this.markers.has(target)) throw new Error('Owned newly opened page required');
    this.bindings.get(jobId)?.pages.add(target);
  }

  takeControl(state: BrowserState, jobs: readonly Job[], context: BrowserContext): { jobIds: string[]; generation: number } {
    const target = key(context);
    const page = state.tabs.find(tab => tab.id === context.tabId && tab.profileId === context.profileId);
    const visible = state.paneTabIds ?? (state.activeTabId ? [state.activeTabId] : []);
    if (state.activeProfileId !== context.profileId || !state.profiles.some(profile => profile.id === context.profileId) || !page || page.lifecycle === 'dormant' || (!visible.includes(context.tabId) && !(page.agentAreaId && state.agentPaneTabIds?.includes(context.tabId)))) throw new Error('Visible owned active-profile page required');
    const origins = new Set([target]);
    const jobIds = new Set<string>();
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'awaiting_approval' && job.status !== 'queued') continue;
      const origin = key(job);
      const binding = this.bindings.get(job.id);
      if (origin !== target && !(binding?.origin === origin && binding.epoch === job.executionEpoch && binding.pages.has(target))) continue;
      origins.add(origin);
      jobIds.add(job.id);
    }
    for (const origin of origins) this.epochs.set(origin, (this.epochs.get(origin) ?? 0) + 1);
    const generation = ++this.generation;
    this.markers.set(target, { context: { profileId:context.profileId,tabId:context.tabId }, generation, state: 'reclaiming' });
    return { jobIds: [...jobIds], generation };
  }

  completeTakeControl(context: BrowserContext, generation: number, ok: boolean): void {
    const marker = this.markers.get(key(context));
    if (marker?.generation === generation && marker.state === 'reclaiming') marker.state = ok ? 'user' : 'unknown';
  }

  getState(state: BrowserState): PageControlState[] {
    return [...this.markers.values()]
      .filter(marker => marker.context.profileId === state.activeProfileId && state.tabs.some(tab => tab.profileId === marker.context.profileId && tab.id === marker.context.tabId))
      .map(marker => ({ ...marker.context, state: marker.state }));
  }
}
