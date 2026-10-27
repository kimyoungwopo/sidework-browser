import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand} from '../src/desktop/security.ts';

for(const type of ['downloads.cancel','downloads.reveal']){
 test(`${type} accepts only an exact bounded download identifier`,()=>{
  assert.deepEqual(parseCommand({type,downloadId:'download_123-abc'}),{type,downloadId:'download_123-abc'});
  for(const downloadId of ['', ' ', '../private', 'x'.repeat(101), null, 3])assert.throws(()=>parseCommand({type,downloadId}));
  for(const key of ['path','url','profileId','allow','command'])assert.throws(()=>parseCommand({type,downloadId:'download-1',[key]:'/private'}));
  assert.throws(()=>parseCommand({type}));
 });
}
