import type { AgentAction, CoreSnapshot, PlanStep, Settings } from '../contract.ts';
import {assertPublicGoalUrl} from '../goal-navigation';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plan');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid plan keys');
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error('Invalid plan text');
  return value;
}
function url(value: unknown): string {
  const raw = text(value, 4096);
  const parsed = new URL(raw);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsafe URL');
  return raw;
}
export function validateInitialDocument(value: unknown): void {
  const input = object(value);
  exact(input, ['url', 'revision',...Object.hasOwn(input,'documentId')?['documentId']:[]]);
  if(Object.hasOwn(input,'documentId'))text(input.documentId,200);
  text(input.url, 4096);
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid initial document revision');
}
export function validateAgentScope(value: unknown): void {
  const input = object(value); const goal=Object.hasOwn(input,'goalId')||Object.hasOwn(input,'allowedOrigins');
  exact(input, ['areaId', 'origin', 'expiresAt',...goal?['goalId','allowedOrigins']:[]]);
  if(goal){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(text(input.goalId,100))||!Array.isArray(input.allowedOrigins)||input.allowedOrigins.length<1||input.allowedOrigins.length>8||new Set(input.allowedOrigins).size!==input.allowedOrigins.length||!input.allowedOrigins.includes(input.origin))throw new Error('Invalid goal origins');
    for(const item of input.allowedOrigins)if(typeof item!=='string'||assertPublicGoalUrl(item).origin!==item)throw new Error('Invalid public goal origin');
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(text(input.areaId,100))) throw new Error('Invalid agent area');
  const origin = text(input.origin,4096), parsed = new URL(origin);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== origin) throw new Error('Invalid agent origin');
  const expiresAt=text(input.expiresAt,64), time=Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString()!==expiresAt) throw new Error('Invalid agent expiry');
}
export function validatePlan(value: unknown): PlanStep {
  const plan = object(value); exact(plan, ['thought', 'action']);
  const thought = text(plan.thought, 8000);
  const input = object(plan.action);
  let action: AgentAction;
  switch (input.type) {
    case 'finish': exact(input, ['type', 'text']); action = { type: 'finish', text: text(input.text, 16000) }; break;
    case 'navigate': case 'open_tab': exact(input, ['type', 'url']); action = { type: input.type, url: url(input.url) }; break;
    case 'click': case 'submit_search': exact(input, ['type', 'ref']); action = { type: input.type, ref: text(input.ref, 256) }; if(input.type==='submit_search' && !/^r[1-9]\d{0,9}$/.test(String(input.ref)))throw new Error('Invalid search ref'); break;
    case 'fill':
      exact(input, ['type', 'ref', 'value']);
      if (typeof input.value !== 'string' || input.value.length > 16000) throw new Error('Invalid fill');
      action = { type: 'fill', ref: text(input.ref, 256), value: input.value }; break;
    case 'computer_click': {
      exact(input, ['type', 'x', 'y', 'frameId']);
      if (typeof input.x !== 'number' || !Number.isInteger(input.x) || input.x < 0 || input.x >= 1280 || typeof input.y !== 'number' || !Number.isInteger(input.y) || input.y < 0 || input.y >= 900) throw new Error('Invalid computer coordinates');
      action = { type: 'computer_click', x: input.x, y: input.y, frameId: text(input.frameId, 256) }; break;
    }
    case 'computer_type':
      exact(input, ['type', 'value', 'frameId']);
      if (typeof input.value !== 'string' || input.value.length > 16000) throw new Error('Invalid computer text');
      action = { type: 'computer_type', value: input.value, frameId: text(input.frameId, 256) }; break;
    case 'computer_key': {
      exact(input, ['type', 'key', 'frameId']);
      const keys = ['Tab', 'Enter', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'] as const;
      if (!keys.some(key => key === input.key)) throw new Error('Invalid computer key');
      action = { type: 'computer_key', key: input.key as typeof keys[number], frameId: text(input.frameId, 256) }; break;
    }
    case 'read_page':
      exact(input, ['type', 'maxScreens']);
      if (typeof input.maxScreens !== 'number' || !Number.isSafeInteger(input.maxScreens) || input.maxScreens < 1 || input.maxScreens > 8) throw new Error('Invalid read_page screen budget');
      action = { type: 'read_page', maxScreens: input.maxScreens }; break;
    case 'scroll':
      exact(input, ['type', 'direction']);
      if (input.direction !== 'up' && input.direction !== 'down') throw new Error('Invalid scroll');
      action = { type: 'scroll', direction: input.direction }; break;
    case 'observe': case 'screenshot': exact(input, ['type']); action = { type: input.type }; break;
    default: throw new Error('Unsupported action');
  }
  return { thought, action };
}

export function validateSettings(value: unknown): Settings {
  const input = object(value);
  exact(input, ['permissionMode', 'provider', 'model', 'memoryEnabled', 'maxSteps', 'confirmMutations']);
  if ((input.permissionMode !== 'guard' && input.permissionMode !== 'read-only') || input.provider !== 'codex' || typeof input.model !== 'string' || input.model.length > 128 || /[\r\n]/.test(input.model) || input.model.includes('\0') || typeof input.memoryEnabled !== 'boolean' || input.confirmMutations !== true || typeof input.maxSteps !== 'number' || !Number.isInteger(input.maxSteps) || input.maxSteps < 1 || input.maxSteps > 20) throw new Error('Invalid settings');
  return input as unknown as Settings;
}
function strings(input: Record<string, unknown>, keys: string[]): void {
  if (keys.some(key => typeof input[key] !== 'string')) throw new Error('Invalid stored text');
}
export function validateSnapshot(value: unknown): CoreSnapshot {
  const input = object(value);
  exact(input, ['jobs', 'activeJobId', 'settings', 'memory', ...(Object.hasOwn(input, 'activeJobIds') ? ['activeJobIds'] : [])]);
  if (Object.hasOwn(input, 'activeJobIds') && (!Array.isArray(input.activeJobIds) || input.activeJobIds.length > 8 || input.activeJobIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(input.activeJobIds).size !== input.activeJobIds.length || input.activeJobId !== (input.activeJobIds[0] ?? null))) throw new Error('Invalid active jobs');
  validateSettings(input.settings);
  if (!Array.isArray(input.jobs) || !Array.isArray(input.memory) || (input.activeJobId !== null && typeof input.activeJobId !== 'string')) throw new Error('Invalid stored state');
  for (const raw of input.memory) { const entry = object(raw); exact(entry, ['id', 'text', 'createdAt']); strings(entry, ['id', 'text', 'createdAt']); }
  const statuses = ['queued', 'running', 'awaiting_approval', 'completed', 'cancelled', 'failed', 'interrupted', 'unknown'];
  for (const raw of input.jobs) {
    const job = object(raw);
    exact(job, ['id', 'prompt', 'profileId', 'tabId', 'status', 'createdAt', 'updatedAt', 'events', 'artifacts', 'answer', 'error', 'approval', 'steps', ...['computerUse', 'shareScreen', 'synchronizedScroll', 'initialDocument', 'agentScope', 'executionEpoch'].filter(key => Object.hasOwn(job, key))]);
    if(Object.hasOwn(job,'executionEpoch') && (typeof job.executionEpoch!=='number' || !Number.isSafeInteger(job.executionEpoch) || job.executionEpoch<0))throw new Error('Invalid stored execution epoch');
    if (Object.hasOwn(job,'agentScope')) validateAgentScope(job.agentScope);
    if (Object.hasOwn(job, 'initialDocument')) validateInitialDocument(job.initialDocument);
    if (['computerUse', 'shareScreen', 'synchronizedScroll'].some(key => Object.hasOwn(job, key) && typeof job[key] !== 'boolean') || (job.computerUse === true && job.shareScreen !== true) || (job.synchronizedScroll === true && job.computerUse === true)) throw new Error('Invalid stored computer consent');
    strings(job, ['id', 'prompt', 'profileId', 'tabId', 'createdAt', 'updatedAt']);
    if (typeof job.status !== 'string' || !statuses.includes(job.status) || !Array.isArray(job.events) || !Array.isArray(job.artifacts) || !Number.isInteger(job.steps) || typeof job.steps !== 'number' || job.steps < 0 || job.steps > 20 || (job.answer !== null && typeof job.answer !== 'string') || (job.error !== null && typeof job.error !== 'string')) throw new Error('Invalid stored job');
    for (const rawEvent of job.events) {
      const event = object(rawEvent); exact(event, ['id', 'at', 'kind', 'text']); strings(event, ['id', 'at', 'kind', 'text']);
      if (!['status', 'thought', 'action', 'observation', 'approval', 'error'].includes(String(event.kind))) throw new Error('Invalid stored event');
    }
    for (const rawArtifact of job.artifacts) {
      const artifact = object(rawArtifact); exact(artifact, ['id', 'kind', 'name', 'path', 'createdAt']); strings(artifact, ['id', 'name', 'path', 'createdAt']);
      if (artifact.kind !== 'screenshot') throw new Error('Invalid stored artifact');
    }
    if (job.approval !== null) {
      const approval = object(job.approval); exact(approval, ['id', 'action', 'digest', 'context', 'revision', 'expiresAt', 'summary']); strings(approval, ['id', 'digest', 'expiresAt', 'summary']);
      const context = object(approval.context); exact(context, ['profileId', 'tabId']); strings(context, ['profileId', 'tabId']);
      if (!Number.isInteger(approval.revision) || !/^[a-f0-9]{64}$/.test(String(approval.digest)) || !Number.isFinite(Date.parse(String(approval.expiresAt)))) throw new Error('Invalid stored approval');
      const action = validatePlan({ thought: 'Validate stored action', action: approval.action }).action;
      if (action.type === 'finish' || action.type === 'read_page') throw new Error('Invalid stored approval action');
    }
  }
  return input as unknown as CoreSnapshot;
}
