import type { BrowserContext, BrowserState, Job } from '../contract.ts';
import { validateAgentScope } from '../core/validation.ts';
import {safePageUrl} from './codex-desktop';
import {goalScopeAllows} from '../goal-navigation';

/** Main-owned native area binding, checked before and after every scoped RPC. */
export function assertAgentPage(jobs:readonly Job[],state:BrowserState,context:BrowserContext,jobId:string,now=Date.now()):void {
 const matches=jobs.filter(job=>job.id===jobId);
 if(matches.length!==1)throw new Error('Unique active task required');
 const job=matches[0];
 if(!job.agentScope)return;
 validateAgentScope(job.agentScope);
 const expires=Date.parse(job.agentScope.expiresAt);
 const page=state.tabs.find(tab=>tab.id===context.tabId&&tab.profileId===context.profileId);
 if(!Number.isFinite(now)||expires<=now||expires-now>3600000||!['running','awaiting_approval'].includes(job.status)||job.profileId!==context.profileId||job.tabId!==context.tabId||state.activeProfileId!==context.profileId||!page||page.lifecycle!=='live'||page.agentAreaId!==job.agentScope.areaId||!state.agentPaneTabIds?.includes(page.id))throw new Error('Agent task no longer owns this page');
 const current=new URL(page.url);
 safePageUrl(page.url);
 if(current.username||current.password||!goalScopeAllows(job.agentScope,page.url))throw new Error('Agent page left its delegated origin');
}
