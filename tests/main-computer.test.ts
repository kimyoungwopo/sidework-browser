import test from 'node:test';import assert from 'node:assert/strict';import {parseCommand} from '../src/desktop/security';
test('synchronized visible batches require explicit DOM mode and content sharing, without relaxing old commands',()=>{
 const value={type:'jobs.startVisible',prompt:'read each pane',shareScreen:true,computerUse:false,synchronizedScroll:true};
 assert.deepEqual(parseCommand(value),value);
 for(const patch of [{computerUse:true},{computerUse:undefined},{shareScreen:false},{synchronizedScroll:'true'},{desktop:true}])assert.throws(()=>parseCommand({...value,...patch}));
 assert.throws(()=>parseCommand({type:'job.start',prompt:'read',synchronizedScroll:true}));
});
test('computer split and batch commands have exact bounds and explicit sharing consent',()=>{
 assert.deepEqual(parseCommand({type:'workspace.split',count:8}),{type:'workspace.split',count:8});for(const count of [0,3,9,'8'])assert.throws(()=>parseCommand({type:'workspace.split',count}));
 assert.deepEqual(parseCommand({type:'jobs.startVisible',prompt:'read each pane',shareScreen:true}),{type:'jobs.startVisible',prompt:'read each pane',shareScreen:true});assert.throws(()=>parseCommand({type:'jobs.startVisible',prompt:'read'}));
 const input={type:'job.start',prompt:'read',tabId:'tab-1',computerUse:true,shareScreen:true};assert.deepEqual(parseCommand(input),input);assert.throws(()=>parseCommand({...input,shareScreen:false}));assert.throws(()=>parseCommand({...input,desktop:true}));assert.deepEqual(parseCommand({type:'jobs.cancelAll'}),{type:'jobs.cancelAll'});
});
