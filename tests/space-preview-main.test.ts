import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import type {BrowserState,PagePreview} from '../src/contract.ts';

const source=await readFile(new URL('../src/desktop/main.ts',import.meta.url),'utf8');
function harness(){
 const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
 const names=['currentPagePreviews','requestPagePreview'];
 const declarations=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name&&names.includes(node.name.text));
 assert.equal(declarations.length,2,'main must own the cache filter and local request handler');
 const scope={pagePreviews:[] as PagePreview[],previewRequests:new Set<string>(),quitting:false,publish:()=>{}};
 const code=ts.transpileModule(declarations.map(node=>node.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const api=vm.runInNewContext(code+';({currentPagePreviews,requestPagePreview})',scope) as {currentPagePreviews:(state:BrowserState)=>PagePreview[];requestPagePreview:(controller:{getState:()=>BrowserState;captureUserPreview:(context:{profileId:string;tabId:string})=>Promise<PagePreview>},context:{profileId:string;tabId:string})=>Promise<void>};
 return {...api,scope};
}
function state():BrowserState{return {profiles:[],activeProfileId:'p',activeTabId:'t',paneTabIds:['t'],tabs:[{id:'t',profileId:'p',revision:3,title:'',url:'https://test/',isLoading:false,canGoBack:false,canGoForward:false,ownership:'user',lifecycle:'live'}]};}
const preview:PagePreview={profileId:'p',tabId:'t',revision:3,imageDataUrl:'data:image/png;base64,eA=='};
test('main keeps only eight exact current profile live pane revisions in memory',()=>{
 const h=harness(),s=state();
 h.scope.pagePreviews=[preview,{...preview,profileId:'other'},{...preview,tabId:'hidden'},{...preview,revision:2}];
 assert.equal(h.currentPagePreviews(s).length,1);assert.equal(h.scope.pagePreviews.length,1);
 h.scope.pagePreviews=Array.from({length:12},(_,i)=>({...preview,tabId:'t'+i}));
 s.paneTabIds=h.scope.pagePreviews.map(p=>p.tabId);s.tabs=h.scope.pagePreviews.map(p=>({...s.tabs[0]!,id:p.tabId}));
 assert.equal(h.currentPagePreviews(s).length,8);assert.equal(h.scope.pagePreviews.length,8);
});
test('main local preview bypasses AI queues, coalesces requests and discards late scopes',async()=>{
 const h=harness();let s=state(),captures=0;let resolve:((p:PagePreview)=>void)|undefined;
 const controller={getState:()=>s,captureUserPreview:async()=>{captures++;return new Promise<PagePreview>(r=>{resolve=r;});}};
 const pending=h.requestPagePreview(controller,preview);
 await h.requestPagePreview(controller,preview);assert.equal(captures,1);
 s={...s,activeProfileId:'other'};resolve!(preview);await pending;assert.equal(h.scope.pagePreviews.length,0);
 s=state();controller.captureUserPreview=async()=>preview;await h.requestPagePreview(controller,preview);
 assert.equal(h.scope.pagePreviews.length,1);
 assert.match(source,/case 'tab.preview':await requestPagePreview\(controller,input\);break;/);
 assert.match(source,/pagePreviews:currentPagePreviews\(/);
});
