import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAgentScope} from '../src/core/validation';
import {isAutomaticAgentAction} from '../src/agent-action-policy';
import {assertAgentPage} from '../src/desktop/agent-scope';
import type {BrowserState,Job,Observation} from '../src/contract';
const origin='https://example.com',other='https://developer.mozilla.org';
const scope={areaId:'area-a',origin,expiresAt:new Date(Date.now()+600000).toISOString(),goalId:'goal-a',allowedOrigins:[origin,other]};
const observation:Observation={profileId:'p',tabId:'a',revision:1,url:origin+'/docs',title:'Docs',text:'Public docs',elements:[],capturedAt:''};

test('goal scopes are bounded explicit public-origin grants; legacy page delegation stays single-origin',()=>{
 assert.doesNotThrow(()=>validateAgentScope(scope));
 for(const patch of [{allowedOrigins:undefined},{goalId:undefined},{allowedOrigins:[other]},{allowedOrigins:[origin,origin]},{allowedOrigins:[origin,'http://127.0.0.1']},{allowedOrigins:[origin,'http://router.local']},{allowedOrigins:[origin,other+'/path']},{allowedOrigins:Array.from({length:9},(_,i)=>`https://d${i}.example.com`)}])assert.throws(()=>validateAgentScope({...scope,...patch}));
 const legacy={areaId:scope.areaId,origin,expiresAt:scope.expiresAt};
 assert.doesNotThrow(()=>validateAgentScope(legacy));
 assert.equal(isAutomaticAgentAction({type:'navigate',url:other+'/en-US/docs/Web/API/AbortController'},observation,legacy),false);
 assert.equal(isAutomaticAgentAction({type:'navigate',url:other+'/en-US/docs/Web/API/AbortController'},observation,scope),true);
 for(const url of ['https://unrelated.example.com','http://127.0.0.1','https://developer.mozilla.org/logout','https://developer.mozilla.org/?token=private'])assert.equal(isAutomaticAgentAction({type:'navigate',url},observation,scope),false);
 const job:Job={...observation,id:'j',prompt:'Read',status:'running',createdAt:'',updatedAt:'',events:[],artifacts:[],answer:null,error:null,approval:null,steps:0,agentScope:scope};
 const state:BrowserState={profiles:[],activeProfileId:'p',activeTabId:'user',agentPaneTabIds:['a'],tabs:[{id:'a',profileId:'p',url:other+'/docs',title:'Docs',revision:1,ownership:'agent',lifecycle:'live',agentAreaId:'area-a',isLoading:false,canGoBack:false,canGoForward:false}]};
 assert.doesNotThrow(()=>assertAgentPage([job],state,{profileId:'p',tabId:'a'},'j'));
 assert.throws(()=>assertAgentPage([{...job,agentScope:legacy}],state,{profileId:'p',tabId:'a'},'j'));
});
