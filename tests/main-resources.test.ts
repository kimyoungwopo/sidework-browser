import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceSample } from '../src/desktop/resources';
import { parseCommand } from '../src/desktop/security';
import type { BrowserTab } from '../src/contract';
test('resource diagnostics report Electron working-set samples and dormant views, not unique RAM',()=>{
 const tabs:BrowserTab[]=[{id:'a',profileId:'default',url:'https://example.test',title:'a',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'live'},{id:'b',profileId:'default',url:'https://other.test',title:'b',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:0,lifecycle:'dormant'}];
 const s=createResourceSample([{pid:10,type:'Browser',memory:{workingSetSize:1024,peakWorkingSetSize:2048},cpu:{percentCPUUsage:0.3}},{pid:11,type:'unexpected-private-path',memory:{workingSetSize:NaN,peakWorkingSetSize:-1},cpu:{percentCPUUsage:Infinity}}],tabs,{browser:500,agent:null});
 assert.equal(s.tabs,2);assert.equal(s.liveTabs,1);assert.equal(s.dormantTabs,1);assert.equal(s.processes[0]?.workingSetKB,1024);assert.equal(s.processes[1]?.workingSetKB,0);assert.equal(s.processes[1]?.role,'Unknown');assert.equal(s.processUptimeAtBrowserReadyMs,500);assert.equal(s.processUptimeAtAgentReadyMs,null);assert.match(s.caveat,/공유|중복/);assert.match(s.caveat,/CLI/);assert(!JSON.stringify(s).includes('example.test'));
});
test('new foundation commands have exact no-secret/no-extra-field boundaries',()=>{
 for(const type of ['agent.connect','diagnostics.refresh','tab.restore']){assert.deepEqual(parseCommand({type}),{type});assert.throws(()=>parseCommand({type,apiKey:'synthetic-not-a-key'}));}
});
