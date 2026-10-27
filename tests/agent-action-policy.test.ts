import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserAction, Observation, ObservedElement } from '../src/contract.ts';
import { isAutomaticAgentAction } from '../src/agent-action-policy.ts';

const now=Date.parse('2026-10-25T00:00:00.000Z');
const scope={areaId:'agent-area-1',origin:'https://fixture.test',expiresAt:new Date(now+60000).toISOString()};
const observation:Observation={profileId:'p',tabId:'t',revision:1,url:'https://fixture.test/page',title:'Fixture',text:'',elements:[],capturedAt:new Date(now).toISOString()};

test('bounded current-origin agent scope permits observation and safe navigation only',()=>{
 assert.equal(isAutomaticAgentAction({type:'observe'},observation,scope,now),true);
 assert.equal(isAutomaticAgentAction({type:'navigate',url:'https://fixture.test/docs'},observation,scope,now),true);
 assert.equal(isAutomaticAgentAction({type:'navigate',url:'https://other.test/docs'},observation,scope,now),false);
});

const element:ObservedElement={ref:'r1',tag:'input',role:'',name:'Show details',inputType:'checkbox',sensitive:false,interaction:{kind:'local'}};
const withElements=(...elements:ObservedElement[]):Observation=>({...observation,elements});
test('routine DOM actions require unique actual refs and compatible trusted interaction metadata',()=>{
 assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements(element),scope,now),true);
 const input:ObservedElement={...element,inputType:'search',interaction:{kind:'input'}};
 assert.equal(isAutomaticAgentAction({type:'fill',ref:'r1',value:'CSS grid'},withElements(input),scope,now),true);
 const link:ObservedElement={...element,tag:'a',inputType:'',interaction:{kind:'navigation',url:'https://fixture.test/docs'}};
 assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements(link),scope,now),true);
 assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements({...element,tag:'button',inputType:'submit',interaction:{kind:'search',url:'https://fixture.test/search'}}),scope,now),true);
 for(const target of [
  {...element,sensitive:true}, {...element,interaction:undefined}, {...element,interaction:{kind:'unknown'}},
  {...element,interaction:{kind:'consequential'}}, {...link,interaction:{kind:'navigation',url:'https://other.test/docs'}},
 ] satisfies ObservedElement[]) assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements(target),scope,now),false);
 assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements(element,element),scope,now),false);
 assert.equal(isAutomaticAgentAction({type:'click',ref:'r2'},withElements(element),scope,now),false);
 assert.equal(isAutomaticAgentAction({type:'fill',ref:'r1',value:'x'.repeat(4001)},withElements(input),scope,now),false);
 assert.equal(isAutomaticAgentAction({type:'fill',ref:'r1',value:'text'},withElements(element),scope,now),false);
});

test('dangerous target semantics override even local metadata and role assertions',()=>{
 for(const name of ['Delete account','Send message','Pay','Login','Grant permissions','Publish','Submit','삭제']) {
  const target={...element,name,role:'tab'};
  assert.equal(isAutomaticAgentAction({type:'click',ref:'r1'},withElements(target),scope,now),false,name);
 }
});

test('scope is exact canonical bounded and unexpired with a finite maximum one-hour TTL',()=>{
 for(const invalid of [
  {...scope,areaId:''},{...scope,areaId:' agent-area-1'}, {...scope,areaId:'x'.repeat(129)},
  {...scope,origin:'https://fixture.test/'}, {...scope,origin:'https://other.test'},
  {...scope,origin:'https://name:pass@fixture.test'}, {...scope,origin:'file://'},
  {...scope,expiresAt:'invalid'}, {...scope,expiresAt:new Date(now).toISOString()},
  {...scope,expiresAt:new Date(now-1).toISOString()}, {...scope,expiresAt:new Date(now+3600001).toISOString()},
 ])assert.equal(isAutomaticAgentAction({type:'observe'},observation,invalid,now),false,JSON.stringify(invalid));
 for(const invalidNow of [NaN,Infinity,-Infinity])assert.equal(isAutomaticAgentAction({type:'observe'},observation,scope,invalidNow),false);
 assert.equal(isAutomaticAgentAction({type:'observe'},{...observation,url:'https://other.test'},scope,now),false);
});

test('runtime malformed scope values cannot be coerced into a valid grant',()=>{
 for(const invalid of [null,undefined,{...scope,areaId:7},{...scope,expiresAt:now+60000},{...scope,expiresAt:' '.repeat(500)+scope.expiresAt}]) {
  assert.equal(Reflect.apply(isAutomaticAgentAction,undefined,[{type:'observe'},observation,invalid,now]),false);
 }
});

test('known search metadata still needs the exact separately granted goal destination',()=>{
 const button:ObservedElement={ref:'r1',tag:'button',role:'',name:'검색',inputType:'submit',sensitive:false,interaction:{kind:'search',url:'https://search.naver.com/search.naver'}};
 const home:Observation={...observation,url:'https://www.naver.com/',elements:[button]};
 const origin='https://www.naver.com';
 const legacy={...scope,origin};
 const bound={...legacy,goalId:'goal-search',allowedOrigins:[origin,'https://search.naver.com']};
 const action:BrowserAction={type:'click',ref:'r1'};
 assert.equal(isAutomaticAgentAction(action,home,legacy,now),false);
 assert.equal(isAutomaticAgentAction(action,home,{...bound,allowedOrigins:[origin]},now),false);
 assert.equal(isAutomaticAgentAction(action,home,bound,now),true);
 for(const url of ['https://search.naver.com.evil.test/search.naver','https://nid.naver.com/nidlogin.login','http://search.naver.com/search.naver']) {
  assert.equal(isAutomaticAgentAction(action,{...home,elements:[{...button,interaction:{kind:'search',url}}]},bound,now),false,url);
 }
 for(const interaction of [{kind:'unknown'},{kind:'consequential'}] as const) {
  assert.equal(isAutomaticAgentAction(action,{...home,elements:[{...button,interaction}]},bound,now),false);
 }
 assert.equal(isAutomaticAgentAction(action,home,{...bound,expiresAt:new Date(now-1).toISOString()},now),false);
 assert.equal(isAutomaticAgentAction(action,{...home,elements:[{...button,name:'로그인',interaction:{kind:'search',url:'https://search.naver.com/search.naver'}}]},bound,now),false);
});

test('missing metadata is per-action fail closed and never licenses arbitrary computer actions',()=>{
 const missing={...element,interaction:undefined};
 for(const action of [
  {type:'click',ref:'r1'}, {type:'fill',ref:'r1',value:'hello'},
  {type:'computer_click',x:1,y:1,frameId:'f'}, {type:'computer_type',value:'hello',frameId:'f'},
  {type:'computer_key',key:'Enter',frameId:'f'}, {type:'open_tab',url:'https://fixture.test/docs'},
 ] satisfies BrowserAction[])assert.equal(isAutomaticAgentAction(action,withElements(missing),scope,now),false);
 for(const action of [{type:'observe'},{type:'scroll',direction:'down'},{type:'screenshot'},{type:'navigate',url:'https://fixture.test/docs'}] satisfies BrowserAction[])assert.equal(isAutomaticAgentAction(action,withElements(missing),scope,now),true);
 for(const url of ['https://fixture.test/delete','https://fixture.test/search?token=private','javascript:alert(1)','https://name:pass@fixture.test/docs'])assert.equal(isAutomaticAgentAction({type:'navigate',url},observation,scope,now),false,url);
 assert.equal(isAutomaticAgentAction({type:'click',ref:''},withElements({...element,ref:''}),scope,now),false);
});
