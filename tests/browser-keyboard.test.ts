import test from 'node:test';
import assert from 'node:assert/strict';
import { browserShortcut } from '../src/desktop/keyboard';
test('browser shortcuts are routed from focused remote pages, not plain typing or IME keys',()=>{
 assert.equal(browserShortcut({type:'keyDown',key:'L',meta:true,control:false}),'L');
 assert.equal(browserShortcut({type:'keyDown',key:'t',meta:false,control:true}),'T');
 assert.equal(browserShortcut({type:'keyDown',key:'j',meta:true,control:false}),'J');
 assert.equal(browserShortcut({type:'keyUp',key:'L',meta:true,control:false}),null);
 assert.equal(browserShortcut({type:'keyDown',key:'l',meta:false,control:false}),null);
 assert.equal(browserShortcut({type:'keyDown',key:'Process',meta:true,control:false}),null);
});
