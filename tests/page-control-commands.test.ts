import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand} from '../src/desktop/security';

test('takeover accepts only an explicit profile and page, never implicit active context or extra capabilities',()=>{
 const command={type:'tab.takeControl',profileId:'default',tabId:'page-A'};
 assert.deepEqual(parseCommand(command),command);
 for(const invalid of [
  {type:'tab.takeControl',tabId:'page-A'},{type:'tab.takeControl',profileId:'default'},
  {...command,profileId:''},{...command,tabId:'../private'},
  {...command,jobId:'other-job'},{...command,executionEpoch:0},{...command,allow:true},
  {...command,url:'https://example.com'},{...command,profileId:null},
 ])assert.throws(()=>parseCommand(invalid),JSON.stringify(invalid));
});
