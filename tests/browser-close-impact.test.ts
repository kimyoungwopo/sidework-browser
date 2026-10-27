import test from 'node:test';
import assert from 'node:assert/strict';
import type {BrowserDownload,Job} from '../src/contract.ts';
import {browserCloseImpact} from '../src/desktop/browser-close-impact.ts';
const job=(id:string,tabId:string,status:Job['status']='running',profileId='default'):Job=>({id,tabId,profileId,status,prompt:'fixture',createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0});
const download=(id:string,tabId:string,state:BrowserDownload['state']='progressing',profileId='default'):BrowserDownload=>({id,tabId,profileId,state,filename:'fixture.txt',sourceOrigin:'https://fixture.example',receivedBytes:0,totalBytes:null,startedAt:'2026-10-24T00:00:00Z',error:null});

test('ordinary browsing and terminal work do not cause blanket close warnings',()=>{
 assert.deepEqual(browserCloseImpact([job('old','a','completed'),job('old-failure','a','unknown')],[download('done','a','completed'),download('blocked','a','blocked')]),{jobIds:[],downloadIds:[]});
});
test('closing a tab targets only its live AI jobs and does not stop background downloads',()=>{
 assert.deepEqual(browserCloseImpact([job('a','tab-a'),job('b','tab-b'),job('other-profile','tab-a','running','private')],[download('file','tab-a')],{profileId:'default',tabId:'tab-a'}),{jobIds:['a'],downloadIds:[]});
});
test('quitting accounts for live tasks and transfers across all profiles',()=>{
 assert.deepEqual(browserCloseImpact([job('run','a'),job('approval','b','awaiting_approval'),job('queued','c','queued','private'),job('done','d','cancelled')],[download('one','a'),download('two','b','progressing','private'),download('failed','c','interrupted')]),{jobIds:['run','approval','queued'],downloadIds:['one','two']});
});
