import test from 'node:test';
import assert from 'node:assert/strict';
import * as desktop from '../src/desktop/codex-desktop';
import type {BrowserState} from '../src/contract';
import {parseCommand} from '../src/desktop/security';
const request={prompt:'  화면의 버튼 확인 &prompt=다른 값\n둘째 줄  ',pageUrl:'https://example.com/a?q=hello%20world',paneIndex:2,targetAppPath:'/Applications/Sidework Codex.app',workspacePath:'/Users/example/Library/Application Support/Sidework Codex/desktop-workspace',requestId:'12345678-1234-1234-1234-123456789abc'};
test('desktop dispatch requires exact consented URL/revision and rejects renderer launch overrides',()=>{
 const value={type:'codexDesktop.handoff' as const,tabId:'a',expectedUrl:'https://example.com/a',expectedRevision:1,prompt:request.prompt,consent:true as const};
 assert.deepEqual(parseCommand(value),value);assert.deepEqual(parseCommand({type:'codexDesktop.check'}),{type:'codexDesktop.check'});
 for(const patch of [{consent:false},{expectedRevision:'1'},{expectedRevision:NaN},{expectedRevision:1.1},{expectedUrl:null},{appPath:'/arbitrary.app'},{prompt:'x'.repeat(4001)}])assert.throws(()=>parseCommand({...value,...patch}));
 const state:BrowserState={profiles:[{id:'default',name:'normal',incognito:false}],activeProfileId:'default',activeTabId:'a',paneTabIds:['a'],tabs:[{id:'a',profileId:'default',title:'page',url:value.expectedUrl,revision:1,isLoading:false,canGoBack:false,canGoForward:false,ownership:'user'}]};
 assert.deepEqual(desktop.assertDesktopConsent(state,value),{pageUrl:value.expectedUrl,paneIndex:1});
 for(const change of [{revision:2},{url:'https://example.com/b'},{isLoading:true}])assert.throws(()=>desktop.assertDesktopConsent({...state,tabs:[{...state.tabs[0]!,...change}]},value));
});
test('desktop discovery and launch use only the verified installed app and never auto-send or install',async()=>{
 const calls:{file:string;args:readonly string[]}[]=[];
 const run=async(file:string,args:readonly string[])=>{calls.push({file,args});if(file==='/usr/bin/plutil')return args.includes('CFBundleIdentifier')?'com.openai.codex\n':'26.1013.40934\n';return '';};
 const status=await desktop.inspectCodexDesktop(true,run,'darwin');assert.equal(status.installed,true);assert.equal(status.targetReady,true);assert.equal(status.version,'26.1013.40934');
 const link=desktop.buildDesktopDeepLink(request);await desktop.launchDesktopDraft(link,run);
 const open=calls.at(-1)!;assert.equal(open.file,'/usr/bin/open');assert.deepEqual(open.args,['-a','/Applications/ChatGPT.app',link]);
 assert.equal((await desktop.inspectCodexDesktop(true,async()=>{throw Error('missing');},'darwin')).installed,false);
 assert.equal((await desktop.inspectCodexDesktop(true,async()=> 'other.bundle','darwin')).installed,false);
 assert.equal((await desktop.inspectCodexDesktop(true,run,'win32')).targetReady,false);
 const before=calls.length;await assert.rejects(desktop.launchDesktopDraft('https://example.com',run));assert.equal(calls.length,before);
 await assert.rejects(desktop.launchDesktopDraft(link,async()=>{throw Error('RAW SECRET command should never be surfaced');}),error=>error instanceof Error&&!error.message.includes('RAW SECRET'));
});
test('official desktop handoff opens a new composer and preserves exact request as encoded data',()=>{
 const url=new URL(desktop.buildDesktopDeepLink(request));
 assert.equal(url.protocol,'codex:');assert.equal(url.hostname,'threads');assert.equal(url.pathname,'/new');
 assert.deepEqual([...url.searchParams.keys()].sort(),['path','prompt']);assert.equal(url.searchParams.get('path'),request.workspacePath);
 const prompt=url.searchParams.get('prompt')!;assert(prompt.includes('@Computer'));assert(prompt.includes('local.sidework.codex'));assert(!url.searchParams.has('autoSend'));
 const data=JSON.parse(prompt.split('SIDEWORK_TASK_JSON:\n')[1]!);
 assert.equal(data.userRequest,request.prompt);assert.equal(data.pageUrl,request.pageUrl);assert.equal(data.paneIndex,2);assert.equal(data.requestId,request.requestId);assert.equal(data.appPath,request.targetAppPath);
});
test('desktop handoff binds a visible nonprivate pane and refuses credential-bearing URL contexts',()=>{
 const s:BrowserState={profiles:[{id:'default',name:'normal',incognito:false}],activeProfileId:'default',activeTabId:'a',paneTabIds:['a','b'],tabs:['a','b','hidden'].map(id=>({id,profileId:'default',title:id,url:'https://example.com/a',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',revision:1}))};
 assert.deepEqual(desktop.desktopTarget(s,'b'),{pageUrl:'https://example.com/a',paneIndex:2});
 assert.throws(()=>desktop.desktopTarget(s,'hidden'));assert.throws(()=>desktop.desktopTarget({...s,profiles:[{...s.profiles[0]!,incognito:true}]},'a'));
 for(const url of ['about:blank','file:///etc/passwd','https://name:pass@example.com/','https://example.com/?access_token=private','https://example.com/#token=private']){
  assert.throws(()=>desktop.desktopTarget({...s,tabs:s.tabs.map(t=>({...t,url}))},'a'));
  assert.throws(()=>desktop.buildDesktopDeepLink({...request,pageUrl:url}));
 }
});
