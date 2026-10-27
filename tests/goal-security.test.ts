import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand,assertSurfaceCommand} from '../src/desktop/security';

test('goal-first IPC accepts a request without any existing browser tab or renderer authority',()=>{
 assert.deepEqual(parseCommand({type:'goals.start',prompt:'두 에이전트로 공식 문서를 비교해줘'}),{type:'goals.start',prompt:'두 에이전트로 공식 문서를 비교해줘'});
 assert.deepEqual(parseCommand({type:'goals.cancel',goalId:'goal-123'}),{type:'goals.cancel',goalId:'goal-123'});
 for(const patch of [{tabId:'user'},{agentScope:{}},{allowedOrigins:['https://example.com']},{profileId:'other'},{computerUse:true}])assert.throws(()=>parseCommand({type:'goals.start',prompt:'Read',...patch}));
 assert.throws(()=>parseCommand({type:'goals.start',prompt:' '}));
 assert.throws(()=>parseCommand({type:'goals.cancel',goalId:'../other'}));
 assert.throws(()=>assertSurfaceCommand('agent',{type:'goals.start',prompt:'Read'}));
});
