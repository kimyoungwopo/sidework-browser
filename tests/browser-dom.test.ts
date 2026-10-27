import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observationScript, actionScript } from '../src/desktop/browser-dom.ts';

function readingPage() {
  const fixture=page();
  vm.runInContext(`
    window.innerWidth=800;window.innerHeight=100;window.scrollY=0;
    document.documentElement.scrollHeight=1000;
    const text={nodeType:3,textContent:'First line. Second line.'};
    const main={tagName:'MAIN',childNodes:[text],getAttribute(){return null;},getBoundingClientRect(){return {top:0,bottom:1000};}};
    document.querySelector=()=>main;
    document.createRange=()=>({start:0,end:0,selectNodeContents(){},setStart(node,offset){this.start=offset;},setEnd(node,offset){this.end=offset;},getClientRects(){const y=(this.start<12?10:210)-window.scrollY;return [{left:0,right:10,top:y,bottom:y+10,width:10,height:10}];}});
  `,fixture.world);
  return fixture;
}

test('reading viewport uses text geometry, changes on actual scroll and retains isolated document identity',()=>{
  const fixture=readingPage(),read=()=>vm.runInContext(observationScript(),fixture.world);
  const first=read();
  assert.equal(first.readingViewport?.text,'First line.');
  assert.equal(first.readingViewport.scrollY,0);
  assert.equal(first.readingViewport.height,100);
  assert.equal(first.readingViewport.scrollHeight,1000);
  vm.runInContext('window.scrollY=200',fixture.world);
  const second=read();
  assert.equal(second.readingViewport.text,'Second line.');
  assert.equal(second.readingViewport.documentId,first.readingViewport.documentId);
  assert.notEqual(second.stamp,first.stamp);
  assert.equal(read().stamp,second.stamp);
  const replacement=readingPage();
  vm.runInContext("crypto.randomUUID=()=>'replacement-document'",replacement.world);
  assert.notEqual(vm.runInContext(observationScript(),replacement.world).readingViewport.documentId,first.readingViewport.documentId);
});

function page() {
  let mutation: ((records?:unknown[]) => void) | undefined;
  let pendingRecords:unknown[]=[];
  const nodes = [
    { tagName: 'BUTTON', textContent: 'Continue', type: '', attrs: {}, value: '' },
    { tagName: 'INPUT', textContent: '', type: 'password', attrs: { name: 'password', value: 'secret123' }, value: 'secret123' },
    { tagName: 'INPUT', textContent: '', type: 'text', attrs: { name: 'card-number', placeholder: '4111111111111111' }, value: '4111111111111111' },
  ].map(n => Object.assign(n, { isConnected: true, disabled: false, getBoundingClientRect: () => ({ width: 10, height: 10 }), getAttribute(k: string): string | null { return (n.attrs as Record<string,string>)[k] ?? null; }, matches: () => false }));
  const body = { childNodes: [{ nodeType: 3, textContent: 'Public page' }, ...nodes] };
  const doc = { title: 'Fixture', body, documentElement: body, querySelectorAll: () => nodes, addEventListener: () => {} };
  const world = vm.createContext({ document: doc, location: { href: 'https://fixture.test/' }, crypto: { randomUUID: () => 'doc-token' }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), MutationObserver: class { constructor(cb: (records?:unknown[]) => void) { mutation = cb; } observe() {} takeRecords() {const records=pendingRecords;pendingRecords=[];return records;} }, window: {} });
  return { world, nodes, mutate: (records?:unknown[]) => mutation?.(records), queue:(records:unknown[])=>{pendingRecords=records;} };
}

test('offscreen text does not exhaust the visible-text budget before later viewport content',()=>{
 const fixture=readingPage();
 vm.runInContext(`
  document.querySelector().childNodes=[{nodeType:3,textContent:'x'.repeat(13000)},{nodeType:3,textContent:'Later visible evidence'}];
  document.createRange=()=>({node:null,setStart(node){this.node=node;},setEnd(){},getClientRects(){const top=this.node.textContent.startsWith('x')?-200:10;return [{left:0,right:10,top,bottom:top+10,width:10,height:10}];}});
 `,fixture.world);
 assert.equal(vm.runInContext(observationScript(),fixture.world).readingViewport.text,'Later visible evidence');
});

test('reading viewport is unavailable for unsupported or invalid geometry instead of returning full-page text',()=>{
 for(const setup of [
  'document.createRange=undefined',
  'document.createRange=()=>({})',
  'document.createRange=()=>({setStart(){},setEnd(){},getClientRects(){throw Error("unsupported");}})',
  'document.createRange=()=>({setStart(){},setEnd(){},getClientRects(){return [{left:0,right:10,top:0,bottom:10,width:NaN,height:10}];}})',
  'document.createRange=()=>({setStart(){},setEnd(){},getClientRects(){return [{left:0,right:10,top:0,bottom:10,width:-1,height:10}];}})',
  'window.scrollY=Infinity',
  'window.innerHeight=0',
  'document.documentElement.scrollHeight=100000001',
 ]) {
  const fixture=readingPage();vm.runInContext(setup,fixture.world);
  const result=vm.runInContext(observationScript(),fixture.world);
  assert.equal(result.readingViewport,undefined,setup);
  assert.equal(result.text,'First line. Second line.','Existing text is not re-labelled as a viewport');
 }
});

test('viewport clipping cannot expose the suffix of a credential whose prefix is offscreen',()=>{
  const fixture=readingPage();
  vm.runInContext(`
    document.querySelector().childNodes=[{nodeType:3,textContent:'Bearer ABCDEFGH123456789'}];
    document.createRange=()=>({start:0,setStart(node,offset){this.start=offset;},setEnd(){},getClientRects(){const top=this.start<7?-200:10;return [{left:0,right:10,top,bottom:top+10,width:10,height:10}];}});
  `,fixture.world);
  assert.equal(vm.runInContext(observationScript(),fixture.world).readingViewport.text,'[redacted]');
});

test('reading viewport excludes controls, secret and concealed subtrees and owned feedback before collecting text',()=>{
  const fixture=readingPage();
  vm.runInContext(`
    const el=(tagName,attrs,text)=>({tagName,childNodes:[{nodeType:3,textContent:text}],getAttribute(k){return attrs[k]??null;},cssDisplay:attrs.cssDisplay??'block'});
    const owned=el('DIV',{},'owned feedback');window.__sideworkVisuals={owns:node=>node===owned};
    document.querySelector().childNodes=[el('BUTTON',{},'control label'),el('DIV',{contenteditable:'true'},'editable value'),el('DIV',{contenteditable:''},'empty editable value'),el('DIV',{contenteditable:'plaintext-only'},'plaintext editable value'),el('DIV',{role:'textbox'},'textbox value'),el('DIV',{id:'secret'},'private value'),el('DIV',{hidden:''},'hidden value'),el('DIV',{'aria-hidden':'true'},'aria value'),el('DIV',{cssDisplay:'none'},'css value'),el('IFRAME',{},'frame value'),el('INPUT',{},'input value'),el('TEXTAREA',{},'textarea value'),el('SELECT',{},'select value'),owned,{nodeType:3,textContent:'4111111111111111 sk-abcdefghijk Public evidence'}];
    getComputedStyle=node=>({display:node.cssDisplay??'block',visibility:'visible'});
    document.createRange=()=>({setStart(){},setEnd(){},getClientRects(){return [{left:0,right:10,top:0,bottom:10,width:10,height:10}];}});
  `,fixture.world);
  assert.equal(vm.runInContext(observationScript(),fixture.world).readingViewport.text,'[redacted][redacted] Public evidence');
  vm.runInContext("document.querySelector().parentElement={tagName:'DIV',getAttribute:k=>k==='hidden'?'':null}",fixture.world);
  assert.equal(vm.runInContext(observationScript(),fixture.world).readingViewport.text,'');
});

test('only the genuine isolated-world feedback host is excluded from observations and privacy checks', () => {
  const fixture=page();
  for(const node of fixture.nodes)Object.assign(node.attrs,{name:'safe'});
  const owned=Object.assign({},fixture.nodes[0],{tagName:'SIDEWORK-VISUAL',textContent:'AI 제어 중',shadowRoot:{}});
  fixture.nodes.push(owned);Object.assign(fixture.world,{__testOwned:owned});
  vm.runInContext('document.body.childNodes.push(__testOwned);window.__sideworkVisuals={owns:node=>node===__testOwned}',fixture.world);
  const snapshot=vm.runInContext(observationScript(),fixture.world);
  assert.equal(snapshot.computer.captureBlocked,false);
  assert.doesNotMatch(JSON.stringify(snapshot),/AI 제어 중|sidework-visual/i);
  const impostor=Object.assign({},owned);fixture.nodes.push(impostor);
  assert.equal(vm.runInContext(observationScript(),fixture.world).computer.captureBlocked,true,'A visually similar page-created node must not gain the exclusion');
});

test('owned visual mutations preserve document leases but real page and impostor mutations invalidate them', () => {
 const fixture=page(),owned={};Object.assign(fixture.world,{__testOwned:owned});
 vm.runInContext('window.__sideworkVisuals={owns:node=>node===__testOwned}',fixture.world);
 const stamp=()=>vm.runInContext(observationScript(),fixture.world).stamp;
 const initial=stamp();
 fixture.mutate([{type:'attributes',target:owned}]);assert.equal(stamp(),initial);
 const hostRecord={type:'childList',target:fixture.world.document,addedNodes:[owned],removedNodes:[]};
 fixture.mutate([hostRecord]);assert.equal(stamp(),initial);
 fixture.queue([hostRecord]);assert.equal(stamp(),initial);
 fixture.mutate([{...hostRecord,addedNodes:[{}]}]);assert.notEqual(stamp(),initial);
 const next=stamp();fixture.mutate([{type:'attributes',target:fixture.nodes[0]}]);assert.notEqual(stamp(),next);
});

test('research reads main article before oversized navigation menus exhaust observation budget', () => {
  const fixture = page();
  vm.runInContext(`
    const main={tagName:'MAIN',childNodes:[{nodeType:3,textContent:'Grid provides two-dimensional rows and columns.'}],getAttribute(){return null;}};
    document.body.childNodes.unshift({nodeType:3,textContent:'Navigation menu '.repeat(1500)});
    document.body.childNodes.push(main);
    document.querySelector=()=>main;
  `,fixture.world);
  const snapshot=vm.runInContext(observationScript(),fixture.world);
  assert.equal(snapshot.text,'Grid provides two-dimensional rows and columns.');
  assert.equal(snapshot.elements[0].name,'Continue');
  assert.doesNotMatch(JSON.stringify(snapshot),/secret123|4111111111111111/);
});

test('research observation excludes hidden and CSS-concealed main-content text', () => {
  const fixture=page();
  vm.runInContext(`
    function el(attrs,text){return {tagName:'DIV',childNodes:[{nodeType:3,textContent:text}],getAttribute(k){return attrs[k]??null;},cssDisplay:attrs.cssDisplay??'block'};}
    const main={tagName:'MAIN',childNodes:[el({hidden:''},'hidden menu secret'),el({'aria-hidden':'true'},'aria hidden text'),el({cssDisplay:'none'},'css hidden text'),{nodeType:3,textContent:'Visible article evidence'}],getAttribute(){return null;}};
    document.querySelector=()=>main;
    getComputedStyle=(node)=>({display:node.cssDisplay??'block',visibility:'visible'});
  `,fixture.world);
  assert.equal(vm.runInContext(observationScript(),fixture.world).text,'Visible article evidence');
});

test('unknown embedded/custom trees and file inputs block capture even beyond listed action targets', () => {
  for(const tagName of ['IFRAME','OBJECT','SECRET-FIELD']) {
    const fixture=page();
    for(const node of fixture.nodes) Object.assign(node.attrs,{name:'safe'});
    Object.assign(fixture.nodes[1]!,{tagName});
    assert.equal(vm.runInContext(observationScript(),fixture.world).computer.captureBlocked,true,tagName);
  }
  const fixture=page();
  for(const node of fixture.nodes) Object.assign(node.attrs,{name:'safe'});
  Object.assign(fixture.nodes[1]!.attrs,{type:'file'});
  assert.equal(vm.runInContext(observationScript(),fixture.world).computer.captureBlocked,true);
});

test('computer snapshot fails closed on sensitive inputs and never serializes their values', () => {
  const fixture=page();
  const snapshot=vm.runInContext(observationScript(),fixture.world);
  assert.equal(snapshot.computer.captureBlocked,true);
  assert.equal(snapshot.computer.focusBlocked,true);
  assert.doesNotMatch(JSON.stringify(snapshot),/secret123|4111111111111111/);
});

test('observation works on insecure HTTP origins without randomUUID', () => {
  const fixture = page();
  vm.runInContext('crypto.randomUUID = undefined; crypto.getRandomValues = (values) => values.fill(42)', fixture.world);
  const snapshot = vm.runInContext(observationScript(), fixture.world);
  assert.equal(snapshot.text, 'Public page Continue');
});

test('live input property changes invalidate snapshots without exposing values', () => {
  const fixture = page();
  const input = fixture.nodes[2]!;
  Object.assign(input.attrs, { name: 'search' });
  const first = vm.runInContext(observationScript(), fixture.world);
  input.value = 'changed programmatically without an input event';
  const second = vm.runInContext(observationScript(), fixture.world);
  assert.notEqual(first.stamp, second.stamp);
  assert.doesNotMatch(JSON.stringify(second), /changed programmatically/);
});

test('typed DOM execution rejects stale refs and sensitive fills without executing source values', () => {
  const fixture = page();
  let clicks = 0;
  Object.assign(fixture.nodes[0]!, { click: () => { clicks++; } });
  const first = vm.runInContext(observationScript(), fixture.world);
  vm.runInContext(actionScript({ type: 'click', ref: first.elements[0].ref }, first.stamp), fixture.world);
  assert.equal(clicks, 1);
  const second = vm.runInContext(observationScript(), fixture.world);
  fixture.mutate();
  assert.throws(() => vm.runInContext(actionScript({ type: 'click', ref: first.elements[0].ref }, second.stamp), fixture.world), /Stale/);
  const fresh = vm.runInContext(observationScript(), fixture.world);
  assert.throws(() => vm.runInContext(actionScript({ type: 'fill', ref: fresh.elements[1].ref, value: 'secret' }, fresh.stamp), fixture.world), /Sensitive/);
  assert.throws(() => vm.runInContext(actionScript({ type: 'click', ref: 'missing' }, fresh.stamp), fixture.world), /target/i);
  assert.equal(clicks, 1);
});

test('trusted walker marks genuine checkbox local but does not infer safety from a generic label',()=>{
 const fixture=page();
 Object.assign(fixture.nodes[0],{tagName:'INPUT',type:'checkbox',textContent:''});
 Object.assign(fixture.nodes[0].attrs,{type:'checkbox',name:'show-details'});
 const snapshot=vm.runInContext(observationScript(),fixture.world);
 assert.equal(snapshot.elements[0].interaction?.kind,'local');
 Object.assign(fixture.nodes[0],{tagName:'BUTTON',textContent:'Safe local routine'});
 Object.assign(fixture.nodes[0].attrs,{type:'button'});
 assert.equal(vm.runInContext(observationScript(),fixture.world).elements[0].interaction?.kind,'unknown');
});

test('danger semantics on targets and forms trump local primitives and reassuring roles',()=>{
 for(const label of ['Delete account','Send message','Pay now','Grant permission','Login','Publish','Submit','삭제']) {
  const fixture=page();
  Object.assign(fixture.nodes[0],{tagName:'INPUT',type:'checkbox',textContent:label});
  Object.assign(fixture.nodes[0].attrs,{type:'checkbox',role:'tab','aria-label':label});
  assert.equal(vm.runInContext(observationScript(),fixture.world).elements[0].interaction?.kind,'consequential',label);
 }
 const fixture=page();
 Object.assign(fixture.nodes[0],{tagName:'INPUT',type:'checkbox',textContent:''});
 Object.assign(fixture.nodes[0].attrs,{type:'checkbox'});
 vm.runInContext(`document.body.childNodes[1].form={tagName:'FORM',textContent:'Delete account',getAttribute(){return null;}}`,fixture.world);
 assert.equal(vm.runInContext(observationScript(),fixture.world).elements[0].interaction?.kind,'consequential');
});

function routinePage(setup:string) {
 const fixture=page();Object.assign(fixture.world,{URL});
 vm.runInContext(`
  const targets=[];
  function control(tagName,attrs={},textContent='') {
   const el={tagName,attrs,textContent,isConnected:true,childNodes:[],value:'private-field-value',checked:false,disabled:false,readOnly:false,
    getAttribute(key){return this.attrs[key]??null;},hasAttribute(key){return key in this.attrs;},getBoundingClientRect(){return {width:10,height:10};},matches(){return false;}};
   targets.push(el);return el;
  }
  document.querySelectorAll=()=>targets;
  document.body.childNodes=[];
  ${setup}
 `,fixture.world);
 return fixture;
}

test('walker emits bounded safe navigation and non-sensitive input metadata without values',()=>{
 const fixture=routinePage(`
  control('A',{href:'/docs?q=grid'},'Docs');
  control('INPUT',{type:'search',name:'q'});
  control('TEXTAREA',{name:'notes'});
  control('INPUT',{type:'password',name:'password'});
  control('A',{href:'https://other.test/docs'},'External');
  control('A',{href:'https://name:password@fixture.test/docs'},'Credential URL');
  control('A',{href:'/docs?api_key=hidden-private'},'Secret URL');
 `);
 const snapshot=vm.runInContext(observationScript(),fixture.world);
 assert.equal(snapshot.elements[0].interaction?.kind,'navigation');
 assert.equal(snapshot.elements[0].interaction?.url,'https://fixture.test/docs?q=grid');
 assert.equal(snapshot.elements[1].interaction?.kind,'input');
 assert.equal(snapshot.elements[2].interaction?.kind,'input');
 assert.equal(snapshot.elements[3].interaction?.kind,'consequential');
 for(const el of snapshot.elements.slice(4))assert.equal(el.interaction?.url,undefined);
 assert.doesNotMatch(JSON.stringify(snapshot.elements),/private-field-value|hidden-private|name:password/);
});

test('only structurally bound tabs and collapsible buttons receive local metadata',()=>{
 const fixture=routinePage(`
  const panel=control('SECTION',{id:'panel',role:'tabpanel'});
  document.getElementById=id=>id==='panel'?panel:null;
  const tab=control('BUTTON',{type:'button',role:'tab','aria-controls':'panel','aria-selected':'true'},'Overview');
  tab.parentElement={getAttribute:key=>key==='role'?'tablist':null};
  control('BUTTON',{type:'button','aria-controls':'panel','aria-expanded':'false'},'Details');
  control('BUTTON',{type:'button',role:'tab'},'Overview');
  control('BUTTON',{type:'button','aria-controls':'missing','aria-expanded':'false'},'Details');
  control('BUTTON',{type:'submit','aria-controls':'panel','aria-expanded':'false'},'Details');
 `);
 const elements=vm.runInContext(observationScript(),fixture.world).elements;
 assert.equal(elements[1].interaction?.kind,'local');
 assert.equal(elements[2].interaction?.kind,'local');
 for(const el of elements.slice(3))assert.equal(el.interaction?.kind,'unknown');
});

// Shapes replayed from qa/google-naver-native-form-probe.log; no native hidden values.
const googleHomepage=`
 location.href='https://www.google.com/';
 const form=control('FORM',{method:'GET',action:'https://www.google.com/search',role:'search'},'.ai {border:0} AI 모드');form.innerText='AI 모드';
 const field=control('TEXTAREA',{name:'q',id:'dynamic-query-id',role:'combobox','aria-label':'검색'});
 const submit=control('INPUT',{type:'submit',name:'btnK',role:'button','aria-label':'Google 검색'});
 const lucky=control('INPUT',{type:'submit',name:'btnI','aria-label':'I’m Feeling Lucky'});
 const ai=control('BUTTON',{type:'button',role:'link'},'.ai {border:0} AI 모드');ai.value='';ai.innerText='AI 모드';
 const file=control('INPUT',{type:'file'});file.value='';file.files=[];
 const file2=control('INPUT',{type:'file'});file2.value='';file2.files=[];
 const hidden=['sca_esv','sxsrf','source','ei','iflsig'].map(name=>control('INPUT',{type:'hidden',name}));
 const duplicateSubmit=control('INPUT',{type:'submit',name:'btnK',role:'button','aria-label':'Google 검색'});
 const duplicateLucky=control('INPUT',{type:'submit',name:'btnI'});
 form.elements=[file,file2,field,ai,submit,lucky,duplicateSubmit,duplicateLucky,...hidden];
 for(const item of form.elements)item.form=form;
`;

test('native Google homepage ordinary search ignores aggregate CSS without authorizing lucky, AI or uploads',()=>{
 const fixture=routinePage(googleHomepage);
 const state=vm.runInContext(observationScript(),fixture.world);
 assert.equal(state.elements[1].interaction.kind,'input','Native Google query was consequential from form CSS border');
 assert.equal(state.elements[2].interaction.kind,'search');
 assert.equal(state.elements[2].interaction.url,'https://www.google.com/search');
 for(const index of [3,4,5,6])assert.ok(!['input','search','local','navigation'].includes(state.elements[index].interaction.kind));
 assert.equal(state.computer.captureBlocked,true);
 assert.doesNotMatch(JSON.stringify(state),/private-field-value/);
});

test('native Google lazy non-submitting toolbar does not poison ordinary search or authorize its buttons',()=>{
 const fixture=routinePage(googleHomepage+`
  for(const role of ['', 'menuitem', 'menuitem', 'menuitemradio', 'menuitemradio', '', '']){
   const helper=control('BUTTON',{type:'button',...(role?{role}:{})},'Upload helper');helper.value='';helper.innerText='';helper.form=form;form.elements.push(helper);
  }
 `);
 const state=vm.runInContext(observationScript(),fixture.world);
 assert.equal(state.elements[1].interaction.kind,'input');assert.equal(state.elements[2].interaction.kind,'search');
 const helpers=state.elements.filter((el:{name:string})=>el.name==='Upload helper');assert.equal(helpers.length,7);
 assert(helpers.every((el:{interaction:{kind:string}})=>!['input','search','navigation','local'].includes(el.interaction.kind)));
 assert.equal(state.computer.captureBlocked,true);
});

test('native referenced delete labels and concealed CSS auxiliaries do not authorize themselves or poison Google query',()=>{
 const f=focusedPage(googleHomepage+`
  const helper=control('BUTTON',{type:'button','aria-labelledby':'tool-delete'},'.decoration {border:0}');helper.value='';helper.innerText='.decoration {border:0}';helper.form=form;helper.cssDisplay='none';form.elements.push(helper);getComputedStyle=e=>({display:e.cssDisplay??'block',visibility:'visible'});
  const label=control('SPAN',{},'Canvas 삭제');document.getElementById=id=>id==='tool-delete'?label:null;
 `);
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world),first=read();
 assert.equal(first.observationMode,'search-form');
 assert(first.elements.every((e:{interaction:{kind:string}})=>['input','search'].includes(e.interaction.kind)));
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'javascript tutorial'},first.stamp,{observation:focusedMode}),f.world);
 const next=read(),button=next.elements.find((e:{interaction:{kind:string}})=>e.interaction.kind==='search');
 vm.runInContext('window.clicked=0;submit.click=()=>window.clicked++;',f.world);
 vm.runInContext(actionScript({type:'click',ref:button.ref},next.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('window.clicked',f.world),1);
 const full=vm.runInContext(observationScript(),f.world);
 assert(full.elements.filter((e:{tag:string})=>e.tag==='button').every((e:{interaction:{kind:string}})=>!['input','search','navigation','local'].includes(e.interaction.kind)));
});

const naverHomepage=`
 location.href='https://www.naver.com/';
 const form=control('FORM',{method:'get',action:'https://search.naver.com/search.naver',role:'search'},'검색 AI 검색');form.innerText='검색 AI 검색';
 const field=control('INPUT',{type:'search',name:'query',id:'query',role:'combobox'});
 const submit=control('BUTTON',{type:'submit',id:'search-btn'},'검색');submit.value='';
 const ai=control('BUTTON',{type:'submit',id:'search-ai-tab-button'},'AI 검색');ai.value='';
 const fieldset=control('FIELDSET',{},'검색 AI 검색');
 const hidden=['where','sm','fbm','acr','acq','qdt','ie','acir','os','bid','pkid','eid','mra','ackey'].map(name=>control('INPUT',{type:'hidden',name}));
 form.elements=[fieldset,...hidden,field,submit,ai];
 for(const item of form.elements)item.form=form;
`;

// A DOM-shaped fixture, not a classifier-only test: native setter and action stamp run.
function focusedPage(setup=naverHomepage) {
 const f=routinePage(setup+`
  window.innerWidth=1000;window.innerHeight=800;window.scrollX=0;window.scrollY=0;
  window.listeners=new Map();
  document.addEventListener=(name,run)=>{if(!window.listeners.has(name))window.listeners.set(name,new Set());window.listeners.get(name).add(run);};
  document.removeEventListener=(name,run)=>window.listeners.get(name)?.delete(run);
  document.documentElement.tagName='HTML';document.documentElement.isConnected=true;
  document.documentElement.getAttribute=()=>null;document.documentElement.attributes=[];
  document.documentElement.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:1000,bottom:800,width:1000,height:800});
  document.documentElement.getRootNode=()=>document;
  form.parentElement=document.documentElement;
  form.childNodes=[...form.elements];document.body.childNodes=[form];
  for(const el of targets){
   if(el!==form)el.parentElement=form;
   el.getRootNode=()=>document;
   Object.defineProperty(el,'attributes',{get(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}});
   el.getBoundingClientRect=()=>{const x=el===submit?200:10;return {x,y:10,left:x,top:10,right:x+100,bottom:40,width:100,height:30};};
   el.contains=node=>node===el || el.childNodes.includes(node);
  }
  document.activeElement=document.body;
  document.querySelectorAll=selector=>selector==='form'? [form]:selector.includes('dialog')?[]:targets;
  document.elementFromPoint=x=>x>150?submit:field;
  document.elementsFromPoint=x=>[document.elementFromPoint(x),form,document.documentElement];
  class NativeInput {} class NativeTextarea {}
  for(const prototype of [NativeInput.prototype,NativeTextarea.prototype])Object.defineProperty(prototype,'value',{set(value){this.value=value;}});
  Object.assign(globalThis,{HTMLInputElement:NativeInput,HTMLTextAreaElement:NativeTextarea,Event:class {constructor(type){this.type=type;}}});
  field.type=field.attrs.type??'textarea';field.dispatchEvent=()=>{};field.focus=()=>{document.activeElement=field;};
 `);
 return f;
}
const focusedMode={kind:'provider-search' as const,scope:'trusted-main-job-a'};

test('native Naver query binds explicit GET submission while ordinary button is hidden, without exposing a click ref',()=>{
 const f=focusedPage();
 vm.runInContext(`for(const el of targets)el.ownerDocument=document;submit.cssDisplay='none';getComputedStyle=e=>({display:e.cssDisplay??'block',visibility:'visible'});class NativeForm {};NativeForm.prototype.requestSubmit=function(button){window.submitted={form:this===form,ordinary:button===submit,query:field.value};};globalThis.HTMLFormElement=NativeForm;`,f.world);
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 const first=read();assert.equal(first.observationMode,'search-form');
 const query=first.elements[0];
 assert.deepEqual(JSON.parse(JSON.stringify(query.interaction.submission)),{kind:'naver-native-get',method:'get',url:'https://search.naver.com/search.naver'});
 assert.equal(first.elements.length,1);
 vm.runInContext(actionScript({type:'fill',ref:query.ref,value:'css tutorial'},first.stamp,{observation:focusedMode}),f.world);
 const filled=read();
 vm.runInContext(actionScript({type:'submit_search',ref:query.ref},filled.stamp,{observation:focusedMode,nativeSearchSubmission:true}),f.world);
 assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(window.submitted)',f.world)),{form:true,ordinary:true,query:'css tutorial'});
});

test('native Naver query submission preserves known disabled hidden routing controls rather than requiring them enabled',()=>{
 const f=focusedPage();
 vm.runInContext(`for(const el of targets)el.ownerDocument=document;for(const el of hidden)if(el.attrs.name!=='where')el.disabled=true;field.value='css tutorial';class NativeForm {};NativeForm.prototype.requestSubmit=function(button){window.submitted=button===submit;};globalThis.HTMLFormElement=NativeForm;`,f.world);
 const first=vm.runInContext(observationScript(focusedMode),f.world);
 assert.equal(first.observationMode,'search-form');
 assert.equal(first.elements[0].interaction.submission?.kind,'naver-native-get','Disabled opaque routing controls are omitted by native GET semantics, not an unavailable ordinary submit');
 vm.runInContext(actionScript({type:'submit_search',ref:first.elements[0].ref},first.stamp,{observation:focusedMode,nativeSearchSubmission:true}),f.world);
 assert.equal(vm.runInContext('window.submitted',f.world),true);
});

for(const change of [
 "form.attrs.method='post'", "form.attrs.action='https://evil.test/'", "form.attrs.action='https://user:pass@search.naver.com/search.naver'", "form.attrs.target='_blank'", "form.attrs.enctype='text/plain'", "form.attrs.novalidate=''",
 "submit.attrs.formaction='https://evil.test/'", "submit.attrs.formmethod='post'", "submit.attrs.formtarget='_blank'", "submit.attrs.formenctype='text/plain'", "submit.attrs.formnovalidate=''", "submit.formNoValidate=true", "form.noValidate=true", "submit.disabled=true", "fieldset.disabled=true", "submit.attrs['aria-disabled']='true'", "submit.isConnected=false", "field.isConnected=false", "form.isConnected=false", "submit.ownerDocument={}", "field.ownerDocument={}", "form.ownerDocument={}", "submit.form=control('FORM')", "field.form=control('FORM')", "submit.attrs.id='search-ai-tab-button'", "field.attrs.name='password'", "form.attrs.method='GETx'", "location.href='https://www.naver.com.evil.test/'", "location.href='https://name:pass@www.naver.com/'", "const extra=control('INPUT',{type:'password',name:'password'});extra.form=form;extra.ownerDocument=document;form.elements.push(extra)", "const extra=control('INPUT',{type:'file'});extra.files=[{name:'private'}];extra.form=form;extra.ownerDocument=document;form.elements.push(extra)",
 "field.value=''", "field.value='   '", "field.value='x'.repeat(4001)", "field.value='Bearer ABCDEFGH12345'", "field.value='sk-abcdefghijklmno'", "field.value='password=private'", "field.value='4111111111111111'", "field.value='css\\nsecret'",
])test(`native submission rejects unsafe live form/query state: ${change}`,()=>{
 const f=focusedPage();
 vm.runInContext(`for(const el of targets)el.ownerDocument=document;field.value='css tutorial';class NativeForm {};NativeForm.prototype.requestSubmit=()=>{window.submitted=true;};globalThis.HTMLFormElement=NativeForm;`,f.world);
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world),first=read(),ref=first.elements[0].ref;
 vm.runInContext(change,f.world);
 const current=read();
 assert.throws(()=>vm.runInContext(actionScript({type:'submit_search',ref},current.stamp,{observation:focusedMode,nativeSearchSubmission:true}),f.world));
 assert.notEqual(vm.runInContext('window.submitted',f.world),true);
});

test('native submission needs host-only capability, exact fresh stamp, same query identity and focused mode',()=>{
 for(const scenario of ['no-grant','stale','foreign-query','unknown-ref','ordinary-submit-ref','full-view']){
  const f=focusedPage();
  vm.runInContext(`for(const el of targets)el.ownerDocument=document;field.value='css tutorial';class NativeForm {};NativeForm.prototype.requestSubmit=()=>{window.submitted=true;};globalThis.HTMLFormElement=NativeForm;`,f.world);
  const first=vm.runInContext(observationScript(focusedMode),f.world);
  if(scenario==='foreign-query')vm.runInContext(`const replacement=control('INPUT',{...field.attrs});replacement.ownerDocument=document;replacement.form=form;form.elements[form.elements.indexOf(field)]=replacement;field.isConnected=false;`,f.world);
  if(scenario==='stale')vm.runInContext("field.value='different public query'",f.world);
  const ref=scenario==='unknown-ref'?'r999':scenario==='ordinary-submit-ref'?first.elements[1].ref:first.elements[0].ref;
  assert.throws(()=>vm.runInContext(actionScript({type:'submit_search',ref},first.stamp,{...(scenario==='full-view'?{}:{observation:focusedMode}),nativeSearchSubmission:scenario!=='no-grant'}),f.world),scenario);
  assert.notEqual(vm.runInContext('window.submitted',f.world),true);
 }
});

test('focused Naver form accepts native React comment nodes and invalidates changed comment state',()=>{
 const f=focusedPage();
 vm.runInContext("window.reactComment={nodeType:8,textContent:'react-boundary',isConnected:true,parentNode:form};form.childNodes.push(window.reactComment);",f.world);
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 const first=read();assert.equal(first.observationMode,'search-form');
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'public native query'},first.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('field.value',f.world),'public native query');
 const after=read();vm.runInContext("window.reactComment.textContent='new-boundary';",f.world);
 f.mutate([{type:'characterData',target:vm.runInContext('window.reactComment',f.world)}]);
 assert.notEqual(read().stamp,after.stamp);
});

test('focused Naver query can be filled before its ordinary submit becomes visible',()=>{
 const f=focusedPage(),read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 vm.runInContext("submit.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});",f.world);
 const first=read();assert.equal(first.observationMode,'search-form');
 assert.equal(first.elements.length,1);assert.equal(first.elements[0].interaction.kind,'input');
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'css tutorial'},first.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('field.value',f.world),'css tutorial');
 vm.runInContext("submit.getBoundingClientRect=()=>({x:200,y:10,left:200,top:10,right:300,bottom:40,width:100,height:30});window.clicks=0;submit.click=()=>window.clicks++;",f.world);
 const next=read(),button=next.elements.find((el:{interaction:{kind:string}})=>el.interaction.kind==='search');
 assert(button);assert.notEqual(next.stamp,first.stamp);
 assert.throws(()=>vm.runInContext(actionScript({type:'click',ref:button.ref},first.stamp,{observation:focusedMode}),f.world),/Stale/);
 vm.runInContext(actionScript({type:'click',ref:button.ref},next.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('window.clicks',f.world),1);
});

test('focused Google ignores only unobserved auxiliary class animation while keeping intended target and security mutations stale',()=>{
 const f=focusedPage(googleHomepage),read=()=>vm.runInContext(observationScript(focusedMode),f.world),first=read();
 vm.runInContext("ai.attrs.class='plR5qb HYcHq';",f.world);
 f.mutate([{type:'attributes',attributeName:'class',target:vm.runInContext('ai',f.world)}]);
 assert.equal(read().stamp,first.stamp);
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'javascript tutorial'},first.stamp,{observation:focusedMode}),f.world);
 const fresh=read();vm.runInContext("ai.attrs.formaction='https://other.test/';",f.world);
 f.mutate([{type:'attributes',attributeName:'formaction',target:vm.runInContext('ai',f.world)}]);
 assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:fresh.elements[0].ref,value:'must not write'},fresh.stamp,{observation:focusedMode}),f.world),/Stale/);
});

test('focused native fill focuses its exact observed query before native input events so focus-dependent ordinary submit can render',()=>{
 const f=focusedPage(),read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 vm.runInContext(`
  window.focuses=0;field.focus=options=>{if(options?.preventScroll!==true)throw Error('Unbounded focus scrolling');window.focuses++;document.activeElement=field;};
  field.dispatchEvent=event=>{if(event.type==='input' && document.activeElement===field)submit.getBoundingClientRect=()=>({x:200,y:10,left:200,top:10,right:300,bottom:40,width:100,height:30});};
  submit.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0});
 `,f.world);
 const first=read();assert.equal(first.elements.length,1);
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'css tutorial'},first.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('window.focuses',f.world),1);
 assert(read().elements.some((e:{interaction:{kind:string}})=>e.interaction.kind==='search'));
});

test('focused fill aborts without writing when native focus changes the intended control or document',()=>{
 for(const change of ["field.isConnected=false", "field.disabled=true", "field.readOnly=true", "form.attrs.method='post'", "field.attrs.name='password'", "location.href='https://other.test/'", "document.activeElement=submit"]){
  const f=focusedPage(),first=vm.runInContext(observationScript(focusedMode),f.world);
  vm.runInContext(`field.focus=()=>{document.activeElement=field;${change};};`,f.world);
  assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'must-not-write'},first.stamp,{observation:focusedMode}),f.world),/Focused native input changed/,change);
  assert.notEqual(vm.runInContext('field.value',f.world),'must-not-write');
 }
});

test('focused Naver excludes unobserved non-ancestor decoration animation but still dispatches only exact query and submit',()=>{
 const f=focusedPage(),read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 vm.runInContext(`
  const decoration=control('DIV',{style:'background:conic-gradient(from 85deg,transparent,cyan);opacity:0'});
  decoration.value=undefined;decoration.textContent='';decoration.parentElement=ai;decoration.childNodes=[];decoration.getRootNode=()=>document;
  Object.defineProperty(decoration,'attributes',{get(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}});
  decoration.getBoundingClientRect=()=>({x:600,y:20,left:600,top:20,right:748,bottom:168,width:148,height:148});
  ai.childNodes.push(decoration);window.decoration=decoration;
 `,f.world);
 const first=read();assert.equal(first.observationMode,'search-form');
 vm.runInContext("window.decoration.attrs.style='background:conic-gradient(from 241deg,transparent,cyan);opacity:1';",f.world);
 f.mutate([{type:'attributes',attributeName:'style',target:vm.runInContext('window.decoration',f.world)}]);
 assert.equal(read().stamp,first.stamp);
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'css tutorial'},first.stamp,{observation:focusedMode}),f.world);
 const fresh=read(),button=fresh.elements.find((e:{interaction:{kind:string}})=>e.interaction.kind==='search');
 vm.runInContext('window.clicks=0;submit.click=()=>window.clicks++;',f.world);
 vm.runInContext(actionScript({type:'click',ref:button.ref},fresh.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('window.clicks',f.world),1);
 assert.equal(vm.runInContext('field.value',f.world),'css tutorial');
});

test('focused native Naver query survives passive news drift without leaking hidden state or viewport evidence',()=>{
 const f=focusedPage();
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 const first=read();
 assert.equal(first.observationMode,'search-form');
 assert.equal(first.documentId,'doc-token');
 assert.equal(first.readingViewport,undefined);
 assert.deepEqual(Array.from(first.elements,(el:{interaction:{kind:string}})=>el.interaction.kind),['input','search']);
 for(let i=0;i<5;i++)f.mutate([{type:'characterData',target:{nodeType:3,textContent:`News ${i}`}}]);
 assert.equal(read().stamp,first.stamp);
 vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'public query'},first.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('field.value',f.world),'public query');
 assert.notEqual(read().stamp,first.stamp);
 assert.doesNotMatch(JSON.stringify(read()),/private-field-value|public query|News/);
 assert.equal(read().computer.captureBlocked,true,'Partial observations must not authorize pixels');
});

for(const setup of [googleHomepage,naverHomepage])test(`focused ${setup===googleHomepage?'Google':'Naver'} form executes native fill and its observed ordinary submit with separate exact leases`,()=>{
 const f=focusedPage(setup),read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 vm.runInContext('window.clicks=0;submit.click=()=>{window.clicks++;};',f.world);
 const first=read();assert.equal(first.observationMode,'search-form');
 assert(first.elements.every((el:{interaction:{kind:string}})=>['input','search'].includes(el.interaction.kind)));
 const query=first.elements.find((el:{interaction:{kind:string}})=>el.interaction.kind==='input');
 vm.runInContext(actionScript({type:'fill',ref:query.ref,value:'public ordinary query'},first.stamp,{observation:focusedMode}),f.world);
 const next=read(),submit=next.elements.find((el:{interaction:{kind:string}})=>el.interaction.kind==='search');
 vm.runInContext(actionScript({type:'click',ref:submit.ref},next.stamp,{observation:focusedMode}),f.world);
 assert.equal(vm.runInContext('window.clicks',f.world),1);
 assert.equal(vm.runInContext('field.value',f.world),'public ordinary query');
 assert.doesNotMatch(JSON.stringify(read()),/private-field-value|public ordinary query/);
 assert.equal(read().readingViewport,undefined);assert.equal(read().computer.captureBlocked,true);
});

test('passive ancestor aggregate news text is not part of the focused actionable surface',()=>{
 const f=focusedPage();
 vm.runInContext("window.headline='Calm headline';Object.defineProperty(document.documentElement,'textContent',{get:()=>window.headline});",f.world);
 const first=vm.runInContext(observationScript(focusedMode),f.world);
 vm.runInContext("window.headline='News about an order and a public login announcement';",f.world);
 f.mutate([{type:'characterData',target:{nodeType:3}}]);
 assert.equal(vm.runInContext(observationScript(focusedMode),f.world).stamp,first.stamp);
});

test('focused leases invalidate private hidden state, form state, identity, geometry, scope, and external security changes',()=>{
 for(const change of [
  "field.value='programmatic-private-query';", "hidden[0].value='opaque-state-changed';",
  "hidden[0].attrs.value='changed-attribute';", "form.attrs.method='post';", "form.attrs.target='_blank';",
  "form.method='post';", "form.action='https://different.test/search';", "form.target='_blank';", "form.enctype='multipart/form-data';", "submit.formAction='https://different.test/search';",
  "form.attrs.action='https://impostor.test/search';", "submit.attrs.formaction='/other';",
  "field.disabled=true;", "field.readOnly=true;", "field.attrs['aria-disabled']='true';", "form.attrs.inert='';",
  "submit.attrs.role='link';", "field.isConnected=false;", "form.isConnected=false;",
  "field.attrs.id='replaced';", "document.activeElement=field;", "window.scrollY=2;", "window.innerWidth=900;",
  "field.getBoundingClientRect=()=>({x:11,y:10,left:11,top:10,right:111,bottom:40,width:100,height:30});",
  "document.elementFromPoint=()=>document.documentElement;",
  "const modal={...form,tagName:'DIALOG',attrs:{open:'',role:'dialog'},elements:[],childNodes:[],form:undefined};Object.defineProperty(modal,'attributes',{get(){return Object.entries(this.attrs).map(([name,value])=>({name,value}));}});const queryAll=document.querySelectorAll;document.querySelectorAll=selector=>selector.includes('dialog')?[modal]:queryAll(selector);",
  "document.baseURI='https://other.test/';", "location.href+='?new=route';",
  "const old=field;const replacement={...field,attrs:{...field.attrs},childNodes:[]};form.elements=form.elements.map(el=>el===old?replacement:el);form.childNodes=form.childNodes.map(el=>el===old?replacement:el);document.elementFromPoint=x=>x>150?submit:replacement;document.elementsFromPoint=x=>[document.elementFromPoint(x),form,document.documentElement];",
  // A security-relevant node outside the selected form must invalidate too.
  "const protectedNode=control('INPUT',{type:'password',name:'password'});protectedNode.getRootNode=()=>document;protectedNode.attributes=[];protectedNode.getBoundingClientRect=()=>({x:400,y:10,left:400,top:10,right:500,bottom:40,width:100,height:30});",
 ]){
  const f=focusedPage(),first=vm.runInContext(observationScript(focusedMode),f.world);
  assert.equal(first.observationMode,'search-form','Fixture must reach focused mode');
  vm.runInContext(change,f.world);
  assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'must-not-write'},first.stamp,{observation:focusedMode}),f.world),/Stale/,change);
  assert.notEqual(vm.runInContext('field.value',f.world),'must-not-write',change);
  assert.doesNotMatch(JSON.stringify(vm.runInContext(observationScript(focusedMode),f.world)),/opaque-state-changed|programmatic-private-query/);
 }
 const f=focusedPage(),first=vm.runInContext(observationScript(focusedMode),f.world);
 assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'no'},first.stamp,{observation:{...focusedMode,scope:'different-job-or-permissions'}}),f.world),/Stale/);
 assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:first.elements[0].ref,value:'no'},first.stamp),f.world),/Stale/,'A focused lease is not a full-page lease');
});

test('focused leases ignore genuine owned feedback insertion but reject page-created ancestor changes',()=>{
 const f=focusedPage();
 vm.runInContext('window.feedback={};window.__sideworkVisuals={owns:node=>node===window.feedback};',f.world);
 const read=()=>vm.runInContext(observationScript(focusedMode),f.world),first=read();
 const root=vm.runInContext('document.documentElement',f.world),owned=vm.runInContext('window.feedback',f.world);
 f.mutate([{type:'childList',target:root,addedNodes:[owned],removedNodes:[]}]);
 assert.equal(read().stamp,first.stamp);
 f.mutate([{type:'childList',target:root,addedNodes:[{}],removedNodes:[]}]);
 assert.notEqual(read().stamp,first.stamp);
});

test('focused trusted-input hooks invalidate the lease and detach when leaving the focused view',()=>{
 const f=focusedPage(),read=()=>vm.runInContext(observationScript(focusedMode),f.world);
 const first=read();
 vm.runInContext("for(const run of window.listeners.get('pointerdown'))run({isTrusted:false});",f.world);
 assert.equal(read().stamp,first.stamp);
 vm.runInContext("for(const run of window.listeners.get('pointerdown'))run({isTrusted:true});",f.world);
 assert.notEqual(read().stamp,first.stamp);
 vm.runInContext(observationScript(),f.world);
 assert.equal(vm.runInContext("window.listeners.get('pointerdown').size",f.world),0);
});

test('focused observation never revives an earlier full-page lease',()=>{
 const f=focusedPage(),first=vm.runInContext(observationScript(),f.world);
 vm.runInContext(observationScript(focusedMode),f.world);
 assert.throws(()=>vm.runInContext(actionScript({type:'fill',ref:first.elements[1].ref,value:'no'},first.stamp),f.world),/Stale/);
});

test('native Naver homepage ordinary search exposes exact cross-origin destination but never its AI submit',()=>{
 const fixture=routinePage(naverHomepage);
 const state=vm.runInContext(observationScript(),fixture.world);
 assert.equal(state.elements[1].interaction.kind,'input','Native Naver query was unknown from its cross-origin GET form');
 assert.equal(state.elements[2].interaction.kind,'search');
 assert.equal(state.elements[2].interaction.url,'https://search.naver.com/search.naver');
 assert.notEqual(state.elements[3].interaction.kind,'search');
 assert.doesNotMatch(JSON.stringify(state),/private-field-value/);
});

test('provider adapters reject disabled query controls before exposing ordinary submits',()=>{
 for(const setup of [googleHomepage,naverHomepage]) {
  const fixture=routinePage(setup+'field.disabled=true;');
  const state=vm.runInContext(observationScript(),fixture.world);
  assert.notEqual(state.elements[2].interaction.kind,'search','A disabled native query cannot authorize its submit');
 }
});

test('provider adapters require a usable native query, including readonly, ARIA and ancestor state',()=>{
 for(const setup of [googleHomepage,naverHomepage])for(const change of [
  'field.readOnly=true;',
  "field.attrs['aria-disabled']='true';",
  "field.parentElement={tagName:'DIV',getAttribute:key=>key==='inert'?'':null};",
 ]) {
  const fixture=routinePage(setup+change);
  const state=vm.runInContext(observationScript(),fixture.world);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
 }
});

test('an invalid provider query role cannot fall through to generic text-input metadata',()=>{
 for(const setup of [googleHomepage,naverHomepage])for(const role of ['textbox','searchbox','']) {
  const fixture=routinePage(setup+`field.attrs.role=${JSON.stringify(role)};`);
  const state=vm.runInContext(observationScript(),fixture.world);
  assert.notEqual(state.elements[1].interaction.kind,'input',role);
  assert.notEqual(state.elements[2].interaction.kind,'search',role);
 }
});

test('provider adapters reject override attributes on both the form and every associated control',()=>{
 for(const setup of [googleHomepage,naverHomepage])for(const target of ['form','field','submit','ai','hidden[0]'])for(const attr of ['formaction','formmethod','formtarget','formenctype']) {
  const change=`${target}.attrs[${JSON.stringify(attr)}]='';`;
  const state=vm.runInContext(observationScript(),routinePage(setup+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
 }
});

test('Google CSS exception cannot conceal consequential rendered helper text or oversized semantic signals',()=>{
 for(const change of ["ai.innerText='Confirm upload';", "hidden[0].attrs.title='x'.repeat(12001);", "delete ai.innerText;"]) {
  const state=vm.runInContext(observationScript(),routinePage(googleHomepage+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
 }
});

test('provider search structural boundary rejects malformed routes, credentials, extra fields and alternate actions',()=>{
 const shared=[
  "location.href='https://impostor.test/';", "location.href=location.href.replace('https:','http:');",
  "location.href+='other';", "location.href+='?route=search';", "location.href+='#fragment';",
  "form.attrs.action='https://impostor.test/search';", "form.attrs.action+='?q=unexpected';",
  "form.attrs.action+='/';", "form.attrs.action=form.attrs.action.replace('https://','https://user@');",
  "form.attrs.action=form.attrs.action.replace('https:','http:');", "form.attrs.action+='#fragment';",
  "form.attrs.method='post';", "form.attrs.method='dialog';", "form.attrs.target='_blank';",
  "form.attrs.enctype='multipart/form-data';", "form.attrs.role='form';", "field.attrs.name='other';",
  "field.attrs.role='button';", "field.form=null;", "submit.attrs.role='link';", "submit.attrs.type='button';",
  "submit.attrs['aria-label']='Confirm';", "form.attrs.title='Manual confirmation';",
  "hidden[0].attrs.name='unknown-routing';", "hidden[0].attrs.name='csrf_token';",
  "const extra=control('INPUT',{type:'hidden',name:'unobserved'});extra.form=form;form.elements.push(extra);",
  "const extra=control('INPUT',{type:'text',name:'notes'});extra.form=form;form.elements.push(extra);",
  "const extra=control('INPUT',{type:'password',name:'password'});extra.form=form;form.elements.push(extra);",
  "const extra=control('BUTTON',{type:'submit'},'Search');extra.form=form;form.elements.push(extra);",
  "const extra=control(field.tagName,{...field.attrs});extra.form=form;form.elements.push(extra);",
  "const extra=control('INPUT',{...hidden[0].attrs});extra.form=form;form.elements.push(extra);",
 ];
 for(const setup of [googleHomepage,naverHomepage])for(const change of shared) {
  const state=vm.runInContext(observationScript(),routinePage(setup+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
  assert.equal(state.elements[2].interaction.url,undefined,change);
 }
 for(const change of [
  "file.files=[{}];", "file.value='selected';", "file.attrs.name='image';", "file.attrs.id='other';",
  "file2.files=[{}];", "file2.value='pasted-image-data';", "ai.value='nonempty';", "ai.attrs.name='other';",
  "lucky.attrs.name='unknown-submit';", "duplicateSubmit.attrs.name='unknown-submit';",
 ]) {
  const state=vm.runInContext(observationScript(),routinePage(googleHomepage+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
  assert.equal(state.computer.captureBlocked,true);
 }
});

test('provider queries execute the trusted native setter and only the ordinary submit click with a fresh lease',()=>{
 for(const setup of [googleHomepage,naverHomepage]) {
  const fixture=routinePage(setup+`
   window.clicks=0;window.events=[];
   class NativeInput {} class NativeTextarea {}
   for(const prototype of [NativeInput.prototype,NativeTextarea.prototype])Object.defineProperty(prototype,'value',{set(value){this.value=value;}});
   Object.assign(globalThis,{HTMLInputElement:NativeInput,HTMLTextAreaElement:NativeTextarea,Event:class {constructor(type){this.type=type;}}});
   field.type=field.attrs.type??'textarea';
   field.dispatchEvent=event=>window.events.push(event.type);
   submit.click=()=>{window.clicks++;window.submittedQuery=field.value;};
   ai.click=()=>{throw Error('AI must not be clicked');};
   window.hiddenBefore=hidden.map(item=>item.value);
  `);
  const read=()=>vm.runInContext(observationScript(),fixture.world);
  const first=read();assert.equal(first.elements[1].interaction.kind,'input');
  vm.runInContext(actionScript({type:'fill',ref:first.elements[1].ref,value:'ordinary public search'},first.stamp),fixture.world);
  assert.equal(vm.runInContext('field.value',fixture.world),'ordinary public search');
  assert.equal(vm.runInContext('window.events.join(",")',fixture.world),'input,change');
  assert.throws(()=>vm.runInContext(actionScript({type:'click',ref:first.elements[2].ref},first.stamp),fixture.world),/Stale/);
  const fresh=read();assert.equal(fresh.elements[2].interaction.kind,'search');
  vm.runInContext(actionScript({type:'click',ref:fresh.elements[2].ref},fresh.stamp),fixture.world);
  assert.equal(vm.runInContext('window.clicks',fixture.world),1);
  assert.equal(vm.runInContext('window.submittedQuery',fixture.world),'ordinary public search');
  assert.equal(vm.runInContext('hidden.every((item,index)=>item.value===window.hiddenBefore[index])',fixture.world),true);
  assert.doesNotMatch(JSON.stringify(read()),/ordinary public search|private-field-value/);
 }
});

test('provider form CSS exclusion preserves rendered manual-confirmation and bounded-state checks',()=>{
 for(const setup of [googleHomepage,naverHomepage])for(const change of [
  "form.innerText='Manual confirmation required';", "form.innerText='x'.repeat(12001);", 'delete form.innerText;',
 ]) {
  const state=vm.runInContext(observationScript(),routinePage(setup+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
 }
});

test('provider controls cannot opt into an explicit form-owner override even when it resolves to the same form',()=>{
 for(const setup of [googleHomepage,naverHomepage])for(const target of ['field','submit','ai','hidden[0]']) {
  const change=`${target}.attrs.form='same-native-form';`;
  const state=vm.runInContext(observationScript(),routinePage(setup+change).world);
  assert.notEqual(state.elements[1].interaction.kind,'input',change);
  assert.notEqual(state.elements[2].interaction.kind,'search',change);
 }
});

test('public Bing GET search exposes its real combobox and observed presentation routing without values',()=>{
 const setup=`
  location.href='https://www.bing.com/';
  const form=control('FORM',{method:'get',action:'/search',role:'search'},'Search');
  const field=control('INPUT',{type:'search',name:'q',role:'combobox'});
  const submit=control('INPUT',{type:'submit',name:'search'},'Search');
  const routing=control('INPUT',{type:'hidden',name:'form'});routing.value='QBLH';
  field.form=form;submit.form=form;routing.form=form;form.elements=[field,submit,routing];
 `;
 const read=(extra='')=>vm.runInContext(observationScript(),routinePage(setup+extra).world).elements;
 const valid=read();assert.equal(valid[1].interaction.kind,'input');assert.equal(valid[2].interaction.kind,'search');
 assert.equal(valid[2].interaction.url,'https://www.bing.com/search');
 assert.doesNotMatch(JSON.stringify(valid),/private-field-value|QBLH/);
 for(const change of [`form.attrs.method='post'`,`form.attrs.action='https://other.test/search'`,`routing.attrs.name='csrf_token'`,`routing.value='UNKNOWN_ROUTE'`,`form.elements.push(control('INPUT',{type:'hidden',name:'session'}))`,`form.elements.push(control('INPUT',{type:'search',name:'q'}))`,`submit.attrs.formaction='/delete'`,`form.attrs.target='_blank'`,`location.href='https://other.test/'`]){
  const elements=read(change);assert.notEqual(elements[2].interaction.kind,'search',change);
  assert.equal(elements[2].interaction.url,undefined,change);
 }
});

test('native search textarea combobox is a bound GET query rather than an arbitrary combobox',()=>{
 const setup=`
  location.href='https://www.bing.com/';
  const form=control('FORM',{method:'get',action:'/search',role:'search'},'Search');
  const field=control('TEXTAREA',{type:'search',name:'q',role:'combobox'});
  const submit=control('INPUT',{type:'submit',name:'search'},'Search');
  const routing=control('INPUT',{type:'hidden',name:'form'});routing.value='QBLH';
  field.form=form;submit.form=form;routing.form=form;form.elements=[submit,field,routing];
 `;
 const read=(extra='')=>vm.runInContext(observationScript(),routinePage(setup+extra).world).elements;
 const elements=read();assert.equal(elements[1].interaction.kind,'input');assert.equal(elements[2].interaction.kind,'search');
 for(const change of [`form.attrs.method='post'`,`delete form.attrs.role`,`field.attrs.name='notes'`,`field.readOnly=true`,`routing.value='UNKNOWN'`])assert.notEqual(read(change)[1].interaction.kind,'input',change);
});

test('empty unnamed Bing image helpers do not authorize files or pollute text-only GET submission',()=>{
 const setup=`
  location.href='https://www.bing.com/';
  const form=control('FORM',{method:'get',action:'/search',role:'search'},'Search');
  const field=control('TEXTAREA',{type:'search',name:'q',role:'combobox'});
  const submit=control('INPUT',{type:'submit',name:'search'},'Search');
  const routing=control('INPUT',{type:'hidden',name:'form'});routing.value='QBLH';
  const file=control('INPUT',{type:'file',id:'sb_fileinput'});file.value='';file.files=[];
  const paste=control('INPUT',{type:'text',id:'sb_imgpst'});paste.value='';
  for(const item of [field,submit,routing,file,paste])item.form=form;
  form.elements=[submit,field,routing,file,paste];
 `;
 const read=(extra='')=>vm.runInContext(observationScript(),routinePage(setup+extra).world);
 const snapshot=read();assert.equal(snapshot.elements[1].interaction.kind,'input');assert.equal(snapshot.elements[2].interaction.kind,'search');
 assert.equal(snapshot.elements[4].interaction.kind,'unknown','File input itself never becomes a routine action');
 assert.equal(snapshot.computer.captureBlocked,true,'Pixel capture stays blocked with file inputs');
 for(const change of [`file.files=[{name:'private.pdf'}]`,`file.value='selected'`,`file.attrs.name='image'`,`file.attrs.id='other'`,`paste.value='private-image-url'`,`paste.attrs.name='imageUrl'`])assert.notEqual(read(change).elements[2].interaction.kind,'search',change);
});

test('omitted HTML form method is the browser default GET, not an unknown or POST method',()=>{
 const setup=`
  const form=control('FORM',{action:'/search',role:'search'},'Search');
  const field=control('INPUT',{type:'search',name:'q'});
  const submit=control('BUTTON',{type:'submit'},'Search');
  field.form=form;submit.form=form;form.elements=[field,submit];
 `;
 const read=(extra='')=>vm.runInContext(observationScript(),routinePage(setup+extra).world).elements[2].interaction;
 assert.equal(read().kind,'search');
 assert.equal(read("form.attrs.method='post'").kind,'unknown');
 assert.equal(read("form.attrs.method='dialog'").kind,'unknown');
});

test('visible label bound to hidden GET-search submit remains an observable exact search control',()=>{
 const setup=`
  const form=control('FORM',{action:'/search',role:'search'},'Search');
  const field=control('INPUT',{type:'search',name:'q'});
  const submit=control('INPUT',{type:'submit',id:'sb_form_go'});submit.ownerDocument=document;
  const label=control('LABEL',{for:'sb_form_go','aria-label':'Web search'});label.control=submit;
  field.form=form;submit.form=form;label.form=form;form.elements=[field,submit];
  window.submitClicks=0;label.click=()=>{window.submitClicks++;};
  const all=document.querySelectorAll;
  document.querySelectorAll=selector=>all(selector).filter(e=>e.tagName!=='LABEL'||selector==='*'||selector.includes('label[for]'));
  getComputedStyle=e=>({visibility:'visible',display:e===submit?'none':'block'});
 `;
 const fixture=routinePage(setup);
 const snapshot=vm.runInContext(observationScript(),fixture.world);
 const label=snapshot.elements.find((e:{tag:string})=>e.tag==='label');
 assert(label,'The visible search label must not disappear with its CSS-hidden submit');
 assert.equal(label.interaction.kind,'search');assert.equal(label.interaction.url,'https://fixture.test/search');
 assert.deepEqual(label.interaction.binding?JSON.parse(JSON.stringify(label.interaction.binding)):undefined,{kind:'label-submit',labelFor:'sb_form_go',controlId:'sb_form_go',controlType:'submit',method:'get'});
 assert.doesNotMatch(JSON.stringify(snapshot),/private-field-value/);
 vm.runInContext(actionScript({type:'click',ref:label.ref},snapshot.stamp),fixture.world);
 assert.equal(vm.runInContext('window.submitClicks',fixture.world),1);
 for(const change of [`label.attrs.for='different'`,`submit.disabled=true`,`submit.isConnected=false`,`submit.ownerDocument={}`,`submit.attrs.type='file'`,`submit.attrs.type='password'`,`form.attrs.method='post'`,`form.attrs.action='https://other.test/search'`]){
  const f=routinePage(setup+change);const state=vm.runInContext(observationScript(),f.world);
  assert.notEqual(state.elements.find((e:{tag:string})=>e.tag==='label')?.interaction.kind,'search',change);
 }
});

test('observed classic Wiby GET query is scoped to its exact legacy control and origin',()=>{
 const setup=`
  location.href='https://wiby.me/';
  const form=control('FORM',{method:'get',action:'/'},'');
  const field=control('INPUT',{type:'text',name:'q',id:'q',role:'form','aria-label':'Main search form'});
  const submit=control('INPUT',{type:'submit'});
  field.form=form;submit.form=form;form.elements=[field,submit];
 `;
 const read=(extra='')=>vm.runInContext(observationScript(),routinePage(setup+extra).world).elements;
 assert.equal(read()[1].interaction.kind,'input');assert.equal(read()[2].interaction.kind,'search');
 assert.equal(read()[2].interaction.url,'https://wiby.me/');
 for(const change of [`location.href='https://other.test/'`,`form.attrs.method='post'`,`field.attrs.id='other'`,`field.attrs.role='button'`,`form.elements.push(control('INPUT',{type:'hidden',name:'session'}))`])assert.notEqual(read(change)[2].interaction.kind,'search',change);
});

test('search metadata requires a genuine same-origin GET search form with exclusively non-sensitive fields',()=>{
 const setup=`
  const form=control('FORM',{method:'get',action:'/search',role:'search'},'Search');
  const field=control('INPUT',{type:'search',name:'q'});
  const submit=control('BUTTON',{type:'submit'},'Search');
  field.form=form;submit.form=form;form.elements=[field,submit];
 `;
 const valid=routinePage(setup);
 const read=(fixture:ReturnType<typeof page>)=>vm.runInContext(observationScript(),fixture.world).elements.find((el:{tag:string})=>el.tag==='button').interaction;
 assert.equal(read(valid)?.kind,'search');
 assert.equal(read(valid)?.url,'https://fixture.test/search');
 for(const mutation of [
  `form.attrs.method='post'`, `form.attrs.action='https://other.test/search'`,
  `field.attrs.name='password'`, `field.attrs.type='hidden'`,
  `form.elements.push(control('INPUT',{type:'password',name:'password'}))`,
  `form.elements.push(control('INPUT',{type:'text',name:'delete-account'}))`,
  `submit.attrs.formaction='/delete'`, `submit.attrs.formmethod='post'`,
  `form.attrs.target='_blank'`, `delete form.attrs.role;field.attrs.type='text'`,
  `form.attrs.action='/search?session=private-field-value'`,
 ]) {
  const fixture=routinePage(setup+mutation);
  assert.notEqual(read(fixture)?.kind,'search',mutation);
  assert.equal(read(fixture)?.url,undefined,mutation);
 }
});

test('base URLs and referenced labels cannot disguise consequential or external destinations',()=>{
 const external=routinePage(`document.baseURI='https://other.test/';control('A',{href:'/docs'},'Docs');`);
 assert.notEqual(vm.runInContext(observationScript(),external.world).elements[0].interaction?.kind,'navigation');
 const labelled=routinePage(`
  const label=control('SPAN',{id:'danger'},'Delete account');
  document.getElementById=id=>id==='danger'?label:null;
  control('INPUT',{type:'checkbox','aria-labelledby':'danger'});
 `);
 assert.equal(vm.runInContext(observationScript(),labelled.world).elements[1].interaction?.kind,'consequential');
 const mixed=routinePage(`
  const wrapper=control('A',{href:'/delete'},'Delete account');
  const checkbox=control('INPUT',{type:'checkbox'});checkbox.parentElement=wrapper;
 `);
 assert.notEqual(vm.runInContext(observationScript(),mixed.world).elements[1].interaction?.kind,'local');
});

test('mixed roles, submit controls and custom elements cannot masquerade as local primitives',()=>{
 const fixture=routinePage(`
  const panel=control('SECTION',{id:'panel',role:'tabpanel'});
  document.getElementById=id=>id==='panel'?panel:null;
  const list={getAttribute:key=>key==='role'?'tablist':null};
  for(const tag of ['INPUT','ARBITRARY-WIDGET']) {
   const target=control(tag,{type:'submit',role:'tab','aria-selected':'true','aria-controls':'panel'},'Overview');target.parentElement=list;
  }
  control('INPUT',{type:'checkbox',role:'button'});
  control('INPUT',{type:'text',role:'combobox'});
  control('A',{href:'/docs',role:'button'},'Docs');
  control('BUTTON',{type:'button',role:'tab','aria-expanded':'true','aria-controls':'panel'},'Overview');
 `);
 for(const el of vm.runInContext(observationScript(),fixture.world).elements.slice(1))assert.equal(el.interaction?.kind,'unknown',el.tag+' '+el.role);
});

test('URL metadata omits form-encoded credentials instead of exposing query values',()=>{
 const fixture=routinePage(`control('A',{href:'/docs?q=Bearer+ABCDEFGH123456789'},'Docs');`);
 const interaction=vm.runInContext(observationScript(),fixture.world).elements[0].interaction;
 assert.equal(interaction.url,undefined);
 assert.doesNotMatch(JSON.stringify(interaction),/ABCDEFGH/);
});

test('isolated snapshot redacts sensitive fields and keeps bounded opaque targets', () => {
  const fixture = page();
  const snapshot = vm.runInContext(observationScript(), fixture.world);
  assert.equal(snapshot.elements.length, 3);
  assert.equal(snapshot.elements[0].name, 'Continue');
  assert.equal(snapshot.elements[1].sensitive, true);
  assert.equal(snapshot.elements[2].sensitive, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret123|4111111111111111/);
  assert.match(snapshot.elements[0].ref, /^r\d+$/);
  assert.equal(snapshot.text, 'Public page Continue');
  assert.equal(vm.runInContext(observationScript(), fixture.world).stamp, snapshot.stamp);
  fixture.mutate();
  assert.notEqual(vm.runInContext(observationScript(), fixture.world).stamp, snapshot.stamp);
});
