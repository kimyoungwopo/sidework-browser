import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, assertTrustedSource } from '../src/desktop/security';

test('trusted UI dispatch rejects arbitrary commands, extra keys and confirmation bypass', () => {
  assert.deepEqual(parseCommand({type:'job.start',prompt:'실제 페이지 요약'}),{type:'job.start',prompt:'실제 페이지 요약'});
  assert.throws(()=>parseCommand({type:'shell.exec',command:'ls'}));
  assert.throws(()=>parseCommand({type:'tab.new',url:'https://example.com/',preload:'/private/file'}));
  assert.throws(()=>parseCommand({type:'settings.update',patch:{confirmMutations:false}}));
  assert.throws(()=>parseCommand({type:'layout.set',sidebarWidth:NaN,top:112,left:66,bottom:26,hideBrowser:false}));
  assert.equal(parseCommand({type:'layout.set',sidebarWidth:0,top:88,left:0,bottom:0,hideBrowser:false}).type,'layout.set');
  assert.throws(()=>parseCommand({type:'layout.set',sidebarWidth:120,top:88,left:0,bottom:0,hideBrowser:false}));
});

test('only exact trusted main-frame URL can use the desktop bridge', () => {
  assert.doesNotThrow(()=>assertTrustedSource('file:///app/index.html','file:///app/index.html',true));
  assert.throws(()=>assertTrustedSource('https://example.com/','file:///app/index.html',true));
  assert.throws(()=>assertTrustedSource('file:///app/index.html','file:///app/index.html',false));
});
