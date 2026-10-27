import test from 'node:test';import assert from 'node:assert/strict';
import {isSafeNavigation,screenLinkAt,isAutomaticComputerAction} from '../src/computer-policy';
import type {ScreenFrame,Observation} from '../src/contract';
test('automatic visual action requires current frame and a safe link; typing and unknown pixels remain approved',()=>{
 const observation:Observation={profileId:'default',tabId:'tab',revision:1,url:'https://example.test/start',title:'test',text:'',elements:[],capturedAt:'',screen:frame};
 assert.equal(isAutomaticComputerAction({type:'computer_click',x:15,y:15,frameId:'frame-test'},observation),true);
 for(const action of [{type:'computer_click',x:90,y:15,frameId:'frame-test'},{type:'computer_click',x:15,y:15,frameId:'stale'},{type:'computer_type',value:'data',frameId:'frame-test'},{type:'computer_key',key:'Enter',frameId:'frame-test'}] as const)assert.equal(isAutomaticComputerAction(action,observation),false);
});
const frame:ScreenFrame={frameId:'frame-test',width:200,height:100,viewportWidth:400,viewportHeight:200,pngBase64:'',safeLinks:[{x:10,y:10,width:20,height:20,url:'https://example.test/article'}]};
test('screen link selection rejects outside, fractional and ambiguous coordinates',()=>{assert.equal(screenLinkAt(frame,15,15)?.url,'https://example.test/article');for(const [x,y] of [[-1,10],[200,10],[15.5,15],[30,15],[NaN,15]])assert.equal(screenLinkAt(frame,x!,y!),undefined);assert.equal(screenLinkAt({...frame,safeLinks:[...frame.safeLinks,...frame.safeLinks]},15,15),undefined);});
test('automatic computer browsing is same-origin credential-free non-risk GET navigation',()=>{assert.equal(isSafeNavigation('https://example.test/start','https://example.test/article?q=hello'),true);for(const url of ['https://other.test/article','javascript:alert(1)','https://user:secret@example.test/','https://example.test/delete/1','https://example.test/checkout','https://example.test/?action=send','https://example.test/oauth?code=123'])assert.equal(isSafeNavigation('https://example.test/start',url),false,url);});
