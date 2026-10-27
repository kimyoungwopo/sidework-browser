import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand} from '../src/desktop/security.ts';

test('local preview requires exact profile and tab and rejects extra authority',()=>{
 const command={type:'tab.preview',profileId:'default',tabId:'tab-1'};
 assert.deepEqual(parseCommand(command),command);
 for(const patch of [{profileId:undefined},{tabId:undefined},{profileId:1},{tabId:''},{tabId:'../x'},{url:'https://secret.test'},{prompt:'read'},{shareScreen:true},{path:'/private'},{revision:0}]) assert.throws(()=>parseCommand({...command,...patch}));
});
