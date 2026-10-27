import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserState, Job } from '../src/contract.ts';
import { assertAgentPage } from '../src/desktop/agent-scope.ts';
const now=Date.parse('2026-10-25T00:00:00.000Z');
const job:Job={id:'j',prompt:'Work',profileId:'p',tabId:'a',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,agentScope:{areaId:'area-a',origin:'https://example.test',expiresAt:new Date(now+600000).toISOString()}};
const state:BrowserState={profiles:[{id:'p',name:'P',incognito:false}],activeProfileId:'p',activeTabId:'user',paneTabIds:['user'],agentPaneTabIds:['a'],tabs:[{id:'a',profileId:'p',title:'A',url:'https://example.test/doc',revision:2,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',lifecycle:'live',agentAreaId:'area-a'}]};

test('a delegated page that redirects to a credential-bearing URL is blocked before observation',()=>{
 const redirected={...state,tabs:[{...state.tabs[0]!,url:'https://example.test/doc?session=synthetic-private'}]};
 assert.throws(()=>assertAgentPage([job],redirected,{profileId:'p',tabId:'a'},'j',now));
});

test('delegated requests bind to their live native agent page rather than any same-profile user tab',()=>{
 assert.doesNotThrow(()=>assertAgentPage([job],state,{profileId:'p',tabId:'a'},'j',now));
 assert.throws(()=>assertAgentPage([job],{...state,agentPaneTabIds:[]},{profileId:'p',tabId:'a'},'j',now));
 assert.throws(()=>assertAgentPage([job],{...state,tabs:[{...state.tabs[0]!,agentAreaId:'area-b'}]},{profileId:'p',tabId:'a'},'j',now));
});
