import type {BrowserContext,BrowserDownload,Job} from '../contract.ts';

/** Closing one tab leaves its browser-owned transfers running; quitting does not. */
export function browserCloseImpact(jobs:readonly Job[],downloads:readonly BrowserDownload[],target?:BrowserContext):{jobIds:string[];downloadIds:string[]}{
 const jobIds=jobs.filter(job=>['queued','running','awaiting_approval'].includes(job.status)&&(!target||(job.profileId===target.profileId&&job.tabId===target.tabId))).map(job=>job.id);
 const downloadIds=target?[]:downloads.filter(download=>download.state==='progressing').map(download=>download.id);
 return {jobIds,downloadIds};
}
