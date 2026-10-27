import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidateProviderVerification } from '../src/desktop/provider-state';
import { DEFAULT_SETTINGS } from '../src/contract';
import type { CoreSnapshot, ProviderStatus } from '../src/contract';
test('model change invalidates historical live verification without inventing logout',()=>{
 const before:CoreSnapshot={settings:{...DEFAULT_SETTINGS},jobs:[],activeJobId:null,memory:[]};
 const status:ProviderStatus={installed:true,authenticated:true,liveVerified:true,detail:'old success'};
 const after={...before,settings:{...before.settings,model:'changed-model'}};
 const result=invalidateProviderVerification(status,before,after);assert.equal(result.liveVerified,false);assert.equal(result.authenticated,true);assert.match(result.detail,/변경/);
 assert.equal(invalidateProviderVerification(status,before,before).liveVerified,true);
});
test('a new failed/unknown job clears success badge; historical failures alone do not',()=>{
 const before:CoreSnapshot={settings:{...DEFAULT_SETTINGS},jobs:[],activeJobId:null,memory:[]};const status:ProviderStatus={installed:true,authenticated:true,liveVerified:true,detail:'old success'};
 const failed={id:'failed-test',prompt:'synthetic',profileId:'default',tabId:'a',status:'failed' as const,createdAt:'x',updatedAt:'x',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0};
 const after:CoreSnapshot={...before,jobs:[failed]};assert.equal(invalidateProviderVerification(status,before,after).liveVerified,false);assert.equal(invalidateProviderVerification(status,after,after).liveVerified,true);
});
