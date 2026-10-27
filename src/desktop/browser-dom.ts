import type { BrowserAction, ObservedElement } from '../contract.ts';

export interface ComputerSnapshot { captureBlocked:boolean; focusBlocked:boolean; viewportWidth:number; viewportHeight:number; links:{x:number;y:number;width:number;height:number;url:string}[] }
export interface DOMObservationMode { kind:'provider-search'; scope:string }
export interface DOMSnapshot { documentId?:string; observationMode?:'search-form'; stamp: string; url: string; title: string; text: string; elements: ObservedElement[]; computer:ComputerSnapshot; readingViewport?:{documentId:string;scrollY:number;height:number;scrollHeight:number;text:string} }

/** This function is serialized by our code, never supplied or modified by a model. */
function installDOM() {
  type Computer = {captureBlocked:boolean;focusBlocked:boolean;viewportWidth:number;viewportHeight:number;links:{x:number;y:number;width:number;height:number;url:string}[]};
  type Snapshot = { documentId?:string; observationMode?:'search-form'; readingViewport?:{documentId:string;scrollY:number;height:number;scrollHeight:number;text:string}; computer:Computer; stamp: string; url: string; title: string; text: string; elements: { ref: string; tag: string; role: string; name: string; inputType: string; sensitive: boolean; interaction:NonNullable<ObservedElement['interaction']> }[] };
  type Command = { type: string; ref?: string; value?: string; direction?: string };
  type Options = { nativeSearchSubmission?:boolean; smoothScroll?:boolean; jobId?:string; observation?:DOMObservationMode };
  type API = { snapshot: (mode?:DOMObservationMode) => Snapshot; act: (command: Command, stamp: string, options?:Options) => void | Promise<void>; cancelScroll:(jobId?:string)=>void };
  const root = window as Window & { __sideworkDOM?: API; __sideworkVisuals?:{owns:(node:Node)=>boolean} };
  if (root.__sideworkDOM) return;
  const documentId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
  let version = 0;
  let nextRef = 0;
  const owned=(node:Node|null|undefined):boolean=>!!node&&root.__sideworkVisuals?.owns(node)===true;
  const refs = new WeakMap<Element, string>();
  const liveValues = new WeakMap<Element, string>();
  let targets = new Map<string, Element>();
  const relevant=(records?:MutationRecord[]):boolean=>!records||records.some(record=>{
    if(owned(record.target))return false;
    if(record.type==='childList'){
      const changed=[...Array.from(record.addedNodes),...Array.from(record.removedNodes)];
      if(changed.length&&changed.every(owned))return false;
    }
    return true;
  });
  let focusedEpoch=0;
  let focusedDependencies=new Set<Node>();
  let focusedAuxiliaryStyles=new Set<Node>();
  const focusedMutation=(records?:MutationRecord[])=>{
    if(!records || records.some(record=>relevant([record]) && !(record.type==='attributes' && focusedAuxiliaryStyles.has(record.target) && ['class','style'].includes(record.attributeName??'')) && (focusedDependencies.has(record.target) || (record.type==='childList' && [...Array.from(record.addedNodes),...Array.from(record.removedNodes)].some(node=>focusedDependencies.has(node))))))focusedEpoch++;
  };
  const observer = new MutationObserver(records => { if(relevant(records))version++; focusedMutation(records); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', () => { version++; }, true);
  document.addEventListener('change', () => { version++; }, true);
  document.addEventListener('scroll', () => { version++; }, true);
  document.addEventListener('focusin', () => { version++; }, true);
  // Trusted input invalidates even if a page later restores a property. This is
  // independent of the main process's all-source cancellation/takeover fence.
  const focusedInputEvents=['input','change','pointerdown','keydown','wheel','touchstart'];
  const focusedInput=(event:Event)=>{if(event.isTrusted)focusedEpoch++;};
  let focusedListening=false;
  const listenFocusedInput=(active:boolean)=>{
    if(active===focusedListening)return;
    for(const event of focusedInputEvents){if(active)document.addEventListener(event,focusedInput,true);else document.removeEventListener(event,focusedInput,true);}
    focusedListening=active;
  };
  const scrub = (text: string) => text.replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted]').replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_./+-]{8,}/gi, '[redacted]');
  const sensitive = (el: Element) => /password|token|secret|payment|credit|card|cc-|cvc|cvv|otp|one-time|authentication/i.test(['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder'].map(k => el.getAttribute(k) ?? '').join(' '));
  const consequential=/(?:delete|remove|destroy|submit|send|pay|purchase|checkout|cart|order|logout|login|log[-_ ]?in|sign[-_ ]?(?:in|up|out)|auth|token|secret|credential|password|unsubscribe|publish|upload|download|permission|grant|revoke|allow|confirm|approve|subscribe|결제|삭제|전송|제출|로그인|인증|권한|게시|발행|구매|가입)/i;
  const semantics=(el:Element,includeText=true):string=>{
    const references=el.getAttribute('aria-labelledby') ?? '';
    const labels=references.trim().split(/\s+/).filter(Boolean);
    if(references.length>512 || labels.length>8)return 'unknown permission';
    return ['name','id','aria-label','title','placeholder','autocomplete','action','formaction','href'].map(key=>el.getAttribute(key) ?? '').join(' ')+' '+(includeText?(el.textContent ?? ''):'')+' '+Array.from((el as HTMLInputElement).labels ?? []).map(label=>label.textContent ?? '').join(' ')+' '+labels.map(id=>document.getElementById?.(id)?.textContent ?? 'unknown permission').join(' ');
  };
  // Omit unsafe URLs entirely rather than rewriting the destination into a different action.
  const routineURL=(raw:string):string|undefined=>{
    try {
      if(raw.length>2048)return;
      const url=new URL(raw,document.baseURI || location.href),page=new URL(location.href);
      const resource=decodeURIComponent(url.pathname+url.search+url.hash);
      if(!['http:','https:'].includes(url.protocol) || url.origin!==page.origin || url.username || url.password || consequential.test(resource) || scrub(resource)!==resource || Array.from(url.searchParams.values()).some(value=>scrub(value)!==value) || Array.from(url.searchParams.keys()).some(key=>/token|secret|password|credential|session|key|code|state|otp|auth/i.test(key)))return;
      return url.href.length<=2048?url.href:undefined;
    }catch{return;}
  };
  const searchShape=(form:Element|null|undefined,fields:Element[]):{field:Element;url:string}|undefined=>{
    if(!form || form.tagName!=='FORM' || (form.getAttribute('method')??'get').toLowerCase()!=='get' || ![null,'','_self'].includes(form.getAttribute('target')))return;
    const url=routineURL(form.getAttribute('action') || location.href);if(!url)return;
    const classicQuery=(field:Element):boolean=>url==='https://wiby.me/' && field.tagName==='INPUT' && field.getAttribute('type')==='text' && field.getAttribute('name')==='q' && field.getAttribute('id')==='q' && field.getAttribute('role')==='form';
    const queries=fields.filter(field=>['INPUT','TEXTAREA'].includes(field.tagName) && (field.getAttribute('type')==='search' || classicQuery(field) || (form.getAttribute('role')==='search' && ['text','',null].includes(field.getAttribute('type')))) && /^(q|query|search)$/i.test(field.getAttribute('name') ?? ''));
    const submits=fields.filter(field=>['INPUT','BUTTON'].includes(field.tagName) && field.getAttribute('type')==='submit');
    if(queries.length!==1 || submits.length!==1)return;
    const field=queries[0]!;
    if((field as HTMLInputElement).disabled || (field as HTMLInputElement).readOnly)return;
    // This observed public Bing routing constant is not a general hidden-field exemption.
    const routing=(item:Element):boolean=>url==='https://www.bing.com/search' && item.tagName==='INPUT' && item.getAttribute('type')==='hidden' && item.getAttribute('name')==='form' && (item as HTMLInputElement).value==='QBLH';
    // Unnamed, empty Bing image helpers are not submitted by a text GET search.
    // This never authorizes their own actions, selected files, pasted data or pixels.
    const emptyHelper=(item:Element):boolean=>{
      if(url!=='https://www.bing.com/search' || item.tagName!=='INPUT' || item.getAttribute('name') || (item as HTMLInputElement).value!=='')return false;
      return (item.getAttribute('id')==='sb_fileinput' && item.getAttribute('type')==='file' && (item as HTMLInputElement).files?.length===0) || (item.getAttribute('id')==='sb_imgpst' && item.getAttribute('type')==='text');
    };
    if(!fields.every(item=>!['formaction','formmethod','formtarget','formenctype'].some(key=>item.getAttribute(key)!==null) && (item===field || item===submits[0] || routing(item) || emptyHelper(item))))return;
    return {field,url};
  };
  // A provider shape is metadata, never an origin grant. Only its native query and
  // ordinary submit are exposed; opaque first-party fields remain browser state.
  const providerSearch=(form:Element|null|undefined,fields:Element[]):{field:Element;submits:Element[];url:string}|undefined=>{
    if(!form || form.tagName!=='FORM' || form.getAttribute('role')!=='search' || fields.length>32 || (form.getAttribute('method')??'get').toLowerCase()!=='get' || ![null,'','_self'].includes(form.getAttribute('target')) || form.getAttribute('enctype')!==null)return;
    let page:URL,action:URL;
    try {page=new URL(location.href);action=new URL(form.getAttribute('action')??'',document.baseURI || location.href);}catch{return;}
    const google=page.href==='https://www.google.com/' && action.href==='https://www.google.com/search';
    const naver=page.href==='https://www.naver.com/' && action.href==='https://search.naver.com/search.naver';
    if(!google && !naver)return;
    if(sensitive(form) || fields.some(sensitive))return;
    const renderedForm=(form as HTMLElement).innerText;
    if(typeof renderedForm!=='string')return;
    // Rendered text is only a veto, never search authority, and is not serialized.
    const formSignals=semantics(form,false)+' '+renderedForm;
    if(formSignals.length>12000 || consequential.test(formSignals))return;
    if([form,...fields].some(item=>['form','formaction','formmethod','formtarget','formenctype'].some(key=>item.getAttribute(key)!==null)) || fields.some(item=>(item as HTMLInputElement).form!==form || !item.isConnected))return;
    const queries=fields.filter(item=>item.getAttribute('role')==='combobox' && (google
      ? item.tagName==='TEXTAREA' && item.getAttribute('name')==='q' && item.getAttribute('type')===null
      : item.tagName==='INPUT' && item.getAttribute('type')==='search' && item.getAttribute('name')==='query' && item.getAttribute('id')==='query'));
    if(queries.length!==1)return;
    const field=queries[0]!;
    if((field as HTMLInputElement).disabled || (field as HTMLInputElement).readOnly || field.getAttribute('aria-disabled')==='true' || owned(field))return;
    let ancestor=field.parentElement,depth=0;
    while(ancestor) {
      if(++depth>32 || ancestor.getAttribute('inert')!==null || ancestor.getAttribute('aria-disabled')==='true' || ['A','BUTTON'].includes(ancestor.tagName) || ['button','link'].includes(ancestor.getAttribute('role')??''))return;
      ancestor=ancestor.parentElement;
    }
    const submits=fields.filter(item=>item.getAttribute('type')==='submit' && ['','button'].includes(item.getAttribute('role')??'') && (google
      ? item.tagName==='INPUT' && item.getAttribute('name')==='btnK'
      : item.tagName==='BUTTON' && !item.getAttribute('name') && item.getAttribute('id')==='search-btn'));
    if(!submits.length || submits.length>(google?2:1))return;
    const hiddenNames=new Set(google?['sca_esv','sxsrf','source','ei','iflsig']:['where','sm','fbm','acr','acq','qdt','ie','acir','os','bid','pkid','eid','mra','ackey']),seen=new Set<string>();
    let helpers=0,lucky=0,ai=0,fieldsets=0,signalBudget=formSignals.length;
    if(!fields.every(item=>{
      const type=item.getAttribute('type'),name=item.getAttribute('name')??'';
      // Observed Google toolbar buttons do not submit a text GET form. They
      // remain non-targets: this branch never classifies their own actions.
      if(google && item.tagName==='BUTTON' && type==='button' && !name && !item.getAttribute('id') && (item as HTMLInputElement).value==='' && ['','link','menuitem','menuitemradio'].includes(item.getAttribute('role')??'')) {
        const rendered=(item as HTMLElement).innerText,box=item.getBoundingClientRect();
        if(typeof rendered!=='string' || ![box.width,box.height].every(Number.isFinite) || box.width<0 || box.height<0)return false;
        // A non-submitting auxiliary's referenced label describes THAT tool,
        // not the public query/ordinary-submit transaction. Its own attributes
        // and genuinely rendered text remain a veto; it never becomes a target.
        let visible=box.width>0 && box.height>0,ancestor:Element|null=item,depth=0;
        while(ancestor){const style=getComputedStyle(ancestor);if(++depth>32)return false;if(style.display==='none' || ['hidden','collapse'].includes(style.visibility))visible=false;ancestor=ancestor.parentElement;}
        const ownSignals=['name','id','aria-label','title','placeholder','autocomplete','action','formaction','href'].map(key=>item.getAttribute(key)??'').join(' ');
        const signals=ownSignals+' '+(visible?rendered:'');
        signalBudget+=signals.length;
        return signalBudget<=12000 && !consequential.test(signals) && ++ai<=8;
      }
      // Only Google's observed native AI helper embeds STYLE in textContent.
      // Its rendered label and own attributes are still checked, never authorized.
      const cssHelper=google && item.tagName==='BUTTON' && type==='button' && item.getAttribute('role')==='link';
      const rendered=(item as HTMLElement).innerText;
      const signals=semantics(item,!cssHelper)+(cssHelper?(typeof rendered==='string'?' '+rendered:' unknown permission'):'');
      signalBudget+=signals.length;
      if(signalBudget>12000 || consequential.test(signals))return false;
      if(item===field || submits.includes(item))return true;
      if(item.tagName==='INPUT' && type==='hidden' && hiddenNames.has(name) && !seen.has(name)) {seen.add(name);return true;}
      if(naver && item.tagName==='FIELDSET' && !name && !item.getAttribute('role'))return ++fieldsets<=1;
      if(naver && item.tagName==='BUTTON' && type==='submit' && !name && item.getAttribute('id')==='search-ai-tab-button' && !item.getAttribute('role'))return ++ai<=1;
      if(!google)return false;
      if(item.tagName==='INPUT' && type==='file' && !name && !item.getAttribute('id') && (item as HTMLInputElement).value==='' && (item as HTMLInputElement).files?.length===0)return ++helpers<=2;
      if(item.tagName==='INPUT' && type==='submit' && name==='btnI' && ['','button'].includes(item.getAttribute('role')??''))return ++lucky<=2;
      if(item.tagName==='BUTTON' && type==='button' && !name && !item.getAttribute('id') && item.getAttribute('role')==='link' && (item as HTMLInputElement).value==='')return ++ai<=1;
      return false;
    }))return;
    return {field,submits,url:action.href};
  };
  // Structural metadata only. Main goal authorization is independently required.
  const nativeSubmission=(field:Element):HTMLButtonElement|undefined=>{
    const form=(field as HTMLInputElement).form;
    if(location.href!=='https://www.naver.com/' || !form?.isConnected || form.ownerDocument!==document || field.ownerDocument!==document || !field.isConnected)return;
    const shape=providerSearch(form,Array.from(form.elements));
    if(!shape || shape.field!==field || shape.url!=='https://search.naver.com/search.naver' || shape.submits.length!==1)return;
    const submit=shape.submits[0] as HTMLButtonElement;
    if(submit.ownerDocument!==document || !submit.isConnected || submit.form!==form || submit.disabled || (submit as unknown as HTMLInputElement).readOnly || submit.getAttribute('aria-disabled')==='true' || owned(submit))return;
    if(Array.from(form.elements).some(el=>el.tagName==='FIELDSET' && (el as HTMLFieldSetElement).disabled) || form.noValidate || submit.formNoValidate || [form,...Array.from(form.elements)].some(el=>['novalidate','formnovalidate'].some(key=>el.getAttribute(key)!==null)))return;
    if((form.method!==undefined && form.method.toLowerCase()!=='get') || (form.action!==undefined && form.action!==shape.url) || (form.target!==undefined && !['','_self'].includes(form.target)))return;
    let ancestor:Element|null=submit,depth=0;
    while(ancestor){if(++depth>32 || ancestor.getAttribute('inert')!==null || ancestor.getAttribute('aria-disabled')==='true' || (ancestor as HTMLFieldSetElement).disabled)return;ancestor=ancestor.parentElement;}
    return submit;
  };
  const interaction=(el:Element):Snapshot['elements'][number]['interaction']=>{
    const tag=el.tagName.toLowerCase(),role=el.getAttribute('role') ?? '';
    const linked=tag==='label'?(el as HTMLLabelElement).control:null;
    const form=(linked as HTMLInputElement|null)?.form ?? (el as HTMLInputElement).form ?? el.closest?.('form');
    const fields=form?Array.from((form as HTMLFormElement).elements ?? []).slice(0,101):[];
    const provider=providerSearch(form,fields);
    const providerTarget=provider && (el===provider.field || provider.submits.includes(el));
    const signals=semantics(el)+' '+(linked?semantics(linked):'')+' '+(form?semantics(form,!providerTarget):'')+' '+(providerTarget?'':fields.map(item=>semantics(item)).join(' '));
    if(sensitive(el) || (linked&&sensitive(linked)) || fields.some(sensitive) || signals.length>12000 || consequential.test(signals))return {kind:'consequential'};
    if(form && fields.length>100)return {kind:'unknown'};
    let ancestor=el.parentElement,depth=0;
    while(ancestor) {
      if(++depth>32 || ancestor.getAttribute('inert')!==null || ancestor.getAttribute('aria-disabled')==='true')return {kind:'unknown'};
      if(['A','BUTTON'].includes(ancestor.tagName) || ['button','link'].includes(ancestor.getAttribute('role') ?? ''))return {kind:consequential.test(semantics(ancestor))?'consequential':'unknown'};
      ancestor=ancestor.parentElement;
    }
    if((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly || el.getAttribute('aria-disabled')==='true')return {kind:'unknown'};
    if(providerTarget)return el===provider.field?{kind:'input',...(nativeSubmission(el)?{submission:{kind:'naver-native-get' as const,method:'get' as const,url:'https://search.naver.com/search.naver' as const}}:{})}:{kind:'search',url:provider.url};
    // Invalid/auxiliary homepage form controls must not fall back to generic inputs.
    if(form && ['https://www.google.com/','https://www.naver.com/'].includes(location.href))return {kind:'unknown'};
    if(tag==='a') {
      if(!['','link'].includes(role) || el.getAttribute('download')!==null || ![null,'','_self'].includes(el.getAttribute('target')))return {kind:'unknown'};
      const href=el.getAttribute('href'),url=href===null?undefined:routineURL(href);
      return url?{kind:'navigation',url}:{kind:'unknown'};
    }
    const search=searchShape(form,fields);
    if(tag==='label') {
      const id=el.getAttribute('for')??'';
      const valid=linked?.tagName==='INPUT' && linked.getAttribute('type')==='submit' && linked.ownerDocument===document && linked.isConnected && !(linked as HTMLInputElement).disabled && !(linked as HTMLInputElement).readOnly && linked.getAttribute('aria-disabled')!=='true' && (linked as HTMLInputElement).form===form && ['','button'].includes(role) && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id) && linked.getAttribute('id')===id;
      return valid&&search?{kind:'search',url:search.url,binding:{kind:'label-submit',labelFor:id,controlId:id,controlType:'submit',method:'get'}}:{kind:'unknown'};
    }
    if(form && ['button','input'].includes(tag) && el.getAttribute('type')==='submit')return search?{kind:'search',url:search.url}:{kind:'unknown'};
    if(tag==='textarea' || (tag==='input' && ['','text','search','email','url','tel','number'].includes(el.getAttribute('type') ?? '')))return {kind:['','textbox','searchbox'].includes(role) || (role==='form' && search?.url==='https://wiby.me/' && search.field===el) || (role==='combobox' && form?.getAttribute('role')==='search' && search?.field===el)?'input':'unknown'};
    if(tag==='input' && ['checkbox','radio'].includes(el.getAttribute('type') ?? ''))return {kind:!role || role===el.getAttribute('type')?'local':'unknown'};
    const controls=el.getAttribute('aria-controls') ?? '';
    const panel=/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(controls)?document.getElementById?.(controls):null;
    if(panel?.isConnected && panel!==el && !owned(panel)) {
      if(role==='tab' && !form && ['button','div','span'].includes(tag) && ['true','false'].includes(el.getAttribute('aria-selected') ?? '') && el.parentElement?.getAttribute('role')==='tablist' && panel.getAttribute('role')==='tabpanel' && (tag==='button'?el.getAttribute('type')==='button':['0','-1'].includes(el.getAttribute('tabindex') ?? '')))return {kind:'local'};
      if(tag==='button' && ['','button'].includes(role) && !form && el.getAttribute('type')==='button' && ['true','false'].includes(el.getAttribute('aria-expanded') ?? ''))return {kind:'local'};
    }
    return {kind:'unknown'};
  };
  const readingViewport = ():Snapshot['readingViewport'] => {
    try {
      const scrollY=window.scrollY,height=window.innerHeight,width=window.innerWidth;
      const scrollHeight=(document.scrollingElement ?? document.documentElement).scrollHeight;
      if(typeof document.createRange!=='function' || ![scrollY,height,width,scrollHeight].every(Number.isFinite) || scrollY<0 || height<=0 || width<=0 || height>30000 || width>30000 || scrollHeight<height || scrollHeight>100000000 || scrollY>scrollHeight-height+1) return;
      let visited=0,measured=0,text='';
      const range=document.createRange();
      const excluded=(el:Element):boolean=>{
        const tag=el.tagName.toLowerCase();
        if(owned(el) || ['script','style','noscript','input','textarea','select','button','iframe','frame','object','embed'].includes(tag) || sensitive(el) || ['','true','plaintext-only'].includes(el.getAttribute('contenteditable')?.toLowerCase() ?? 'absent') || /^(button|textbox|combobox|listbox|checkbox|radio|slider|spinbutton|switch)$/.test(el.getAttribute('role') ?? '') || el.getAttribute('hidden')!==null || el.getAttribute('aria-hidden')==='true')return true;
        const style=getComputedStyle(el);
        return style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse';
      };
      const walk=(node:Node):void=>{
        if(owned(node) || ++visited>6000 || measured>=24000 || text.length>=12000)return;
        if(node.nodeType===3) {
          const value=node.textContent ?? '';
          // Detect protected spans before viewport clipping can hide a credential prefix.
          const protectedSpans=Array.from(value.matchAll(/\b(?:\d[ -]?){13,19}\b|\b(?:sk-|Bearer\s+)[A-Za-z0-9_./+-]{8,}/gi),match=>({start:match.index,end:match.index+match[0].length}));
          let spanIndex=0,lastRedacted=-1;
          text+=' ';
          for(let i=0;i<value.length && measured<24000 && text.length<12000;i++,measured++) {
            range.setStart(node,i);range.setEnd(node,i+1);
            const rects=Array.from(range.getClientRects());
            if(rects.length>64)throw new Error('Unsupported text geometry');
            let visible=false;
            for(const rect of rects) {
              if(![rect.left,rect.right,rect.top,rect.bottom,rect.width,rect.height].every(Number.isFinite) || rect.width<0 || rect.height<0 || rect.right<rect.left || rect.bottom<rect.top)throw new Error('Unsupported text geometry');
              if(rect.width>0 && rect.height>0 && rect.right>0 && rect.left<width && rect.bottom>0 && rect.top<height)visible=true;
            }
            while(spanIndex<protectedSpans.length && i>=protectedSpans[spanIndex].end)spanIndex++;
            const protectedSpan=protectedSpans[spanIndex];
            if(visible) {
              if(protectedSpan && i>=protectedSpan.start) {if(lastRedacted!==protectedSpan.start){text+='[redacted]';lastRedacted=protectedSpan.start;}}
              else text+=value[i];
            }
            else if(text && !/\s$/.test(text))text+=' ';
          }
          return;
        }
        const el=node as Element;
        if(el.tagName && excluded(el))return;
        for(const child of Array.from(node.childNodes ?? [])) {
          if(visited>=6000 || measured>=24000 || text.length>=12000)break;
          walk(child);
        }
      };
      const scope=document.querySelector?.('main, [role="main"], article') ?? document.body;
      let ancestor=scope?.parentElement;
      while(ancestor) {
        if(++visited>6000)return;
        if(excluded(ancestor))return {documentId,scrollY,height,scrollHeight,text:''};
        ancestor=ancestor.parentElement;
      }
      walk(scope);
      return {documentId,scrollY,height,scrollHeight,text:scrub(text).replace(/\s+/g,' ').trim().slice(0,12000)};
    } catch {return;}
  };
  const identities=new WeakMap<object,number>();let nextIdentity=0;
  const identity=(node:object|null|undefined):number=>{if(!node)return 0;let id=identities.get(node);if(!id){id=++nextIdentity;identities.set(node,id);}return id;};
  // The fingerprint NEVER leaves the isolated world. Exact string equality,
  // rather than a truncated hash, yields a monotonic opaque lease without
  // leaking query, hidden field, attribute or file state through the stamp.
  let focusedFingerprint:string|undefined,focusedRevision=0;
  const focusedSnapshot=(mode:DOMObservationMode):Snapshot|undefined=>{
    try {
      if(mode.kind!=='provider-search' || !mode.scope || !['https://www.google.com/','https://www.naver.com/'].includes(location.href))return;
      const forms=Array.from(document.querySelectorAll('form'));
      if(forms.length>32)return;
      const matches=forms.map(form=>({form,shape:providerSearch(form,Array.from((form as HTMLFormElement).elements))})).filter(item=>item.shape);
      if(matches.length!==1)return;
      const {form,shape}=matches[0]!;if(!shape)return;
      const controls=Array.from((form as HTMLFormElement).elements);
      const dependencies=new Set<Node>(),auxiliaryStyles=new Set<Node>();const records:unknown[]=[];
      let budget=0;
      const rect=(el:Element)=>{
        const box=el.getBoundingClientRect();const values=[box.x,box.y,box.left,box.top,box.right,box.bottom,box.width,box.height];
        if(!values.every(Number.isFinite))throw new Error('Unsupported search geometry');return values;
      };
      const describe=(node:Node,children=false,decorativeAuxiliary=false):void=>{
        if(owned(node))return;
        if(++budget>2000)throw new Error('Oversized search surface');
        dependencies.add(node);
        if(node.nodeType===3 || node.nodeType===8){records.push([identity(node),node.textContent]);return;}
        const el=node as Element,input=el as HTMLInputElement;
        if(!el.isConnected || el.getRootNode()!==document || !el.attributes || el.shadowRoot)throw new Error('Unknown search tree');
        const style=getComputedStyle(el);
        if(decorativeAuxiliary)auxiliaryStyles.add(el);else auxiliaryStyles.delete(el);
        records.push([identity(el),identity(el.parentNode ?? el.parentElement),el.tagName,
          Array.from(el.attributes,attr=>[attr.name,attr.value]).filter(([name])=>!decorativeAuxiliary || !['class','style'].includes(name!)).sort((a,b)=>a[0]!.localeCompare(b[0]!)),
          input.value,input.checked,input.disabled,input.readOnly,input.type,identity(input.form),
          [(el as HTMLFormElement).method,(el as HTMLFormElement).action,(el as HTMLFormElement).target,(el as HTMLFormElement).enctype,
            input.formAction,input.formMethod,input.formTarget,input.formEnctype,input.formNoValidate,(el as HTMLFormElement).noValidate],
          input.files?Array.from(input.files,file=>[identity(file),file.name,file.size,file.type,file.lastModified]):null,
          sensitive(el),el===shape.field || shape.submits.includes(el)?interaction(el):null,decorativeAuxiliary?null:rect(el),
          decorativeAuxiliary?null:['display','visibility','opacity','pointerEvents','position','zIndex','transform','clipPath','overflow','contentVisibility'].map(key=>style[key as keyof CSSStyleDeclaration]),
          decorativeAuxiliary?null:[el.scrollLeft,el.scrollTop]]);
        if(children)for(const child of Array.from(el.childNodes))describe(child,true);
        for(const label of Array.from(input.labels ?? []))if(!dependencies.has(label))describe(label,true);
        for(const id of (el.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean)){
          const label=document.getElementById(id);if(!label)throw new Error('Missing search label');if(!dependencies.has(label))describe(label,true);
        }
      };
      // Focused output observes only query + ordinary submit. Do not make a
      // sibling decorative animation inside an unobserved auxiliary a lease
      // dependency. Exact form/associated-control state, every control ancestor,
      // observed target/label subtrees and all security context remain pinned.
      describe(form);
      for(const child of Array.from(form.childNodes))if(child.nodeType===3 || child.nodeType===8)describe(child);
      for(const control of controls){
        const decorativeAuxiliary=location.href==='https://www.google.com/' && control.tagName==='BUTTON' && control.getAttribute('type')==='button' && control!==shape.field && !shape.submits.includes(control);
        describe(control,control===shape.field || shape.submits.includes(control),decorativeAuxiliary);
        let parent=control.parentElement,depth=0;
        while(parent && parent!==form){if(++depth>32)throw new Error('Deep control ancestry');if(!dependencies.has(parent))describe(parent);parent=parent.parentElement;}
      }
      let ancestor=form.parentElement,depth=0;
      while(ancestor){if(++depth>32)throw new Error('Deep search ancestry');describe(ancestor);ancestor=ancestor.parentElement;}
      const blockers=Array.from(document.querySelectorAll('dialog,[aria-modal="true"],[role="dialog"],[role="alertdialog"]')).filter(el=>!owned(el));
      if(blockers.length>32)return;
      for(const blocker of blockers)describe(blocker,true);
      // The narrow text view does not hide security changes elsewhere in the
      // document. Pixel eligibility is still unconditionally denied here.
      const all=Array.from(document.querySelectorAll('*')).filter(el=>!owned(el));
      if(all.length>6000)return;
      for(const el of all)if(!dependencies.has(el) && (sensitive(el) || el.tagName.includes('-') || el.getAttribute('type')==='file' || ['IFRAME','FRAME','OBJECT','EMBED'].includes(el.tagName) || !!el.shadowRoot || el.getAttribute('contenteditable')!==null))describe(el,true);
      const elements:Snapshot['elements']=[];const nextTargets=new Map<string,Element>();
      for(const el of [shape.field,...shape.submits]){
        const box=el.getBoundingClientRect(),style=getComputedStyle(el);
        if(!el.isConnected || box.width<=0 || box.height<=0 || style.display==='none' || ['hidden','collapse'].includes(style.visibility))continue;
        // Exact hit-stack identity detects an overlay even when it has no modal role.
        const x=box.x+box.width/2,y=box.y+box.height/2;
        if(x<0 || y<0 || x>=window.innerWidth || y>=window.innerHeight)continue;
        const hit=document.elementFromPoint(x,y);
        if(!hit || (hit!==el && !el.contains(hit)))continue;
        const stack=document.elementsFromPoint(x,y).filter(node=>!owned(node));
        records.push(['hit',identity(el),stack.map(identity)]);
        for(const node of stack)if(!dependencies.has(node))describe(node);
        let ref=refs.get(el);if(!ref){ref=`r${++nextRef}`;refs.set(el,ref);}
        const metadata=interaction(el);
        if(metadata.kind!==(el===shape.field?'input':'search'))return;
        elements.push({ref,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')??'',name:scrub(el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el===shape.field?'Search query':el.textContent || 'Search')).trim().slice(0,180),inputType:el.getAttribute('type')??'',sensitive:false,interaction:metadata});
        nextTargets.set(ref,el);
      }
      // A native ordinary submit can stay hidden until typing; it remains in the
      // private form fingerprint but cannot be clicked until actually observed.
      if(!nextTargets.has(refs.get(shape.field)??''))return;
      const viewport=[window.innerWidth,window.innerHeight,window.scrollX,window.scrollY];
      if(!viewport.every(Number.isFinite) || viewport[0]!<=0 || viewport[1]!<=0)return;
      const visual=window.visualViewport;
      const fingerprint=JSON.stringify([mode,documentId,identity(document),identity(document.documentElement),location.href,document.baseURI,document.title,focusedEpoch,viewport,window.devicePixelRatio,
        visual?[visual.width,visual.height,visual.offsetLeft,visual.offsetTop,visual.pageLeft,visual.pageTop,visual.scale]:null,identity(document.activeElement),records,elements]);
      if(fingerprint!==focusedFingerprint){focusedFingerprint=fingerprint;focusedRevision++;}
      focusedDependencies=dependencies;focusedAuxiliaryStyles=auxiliaryStyles;targets=nextTargets;
      return {documentId,observationMode:'search-form',stamp:`${documentId}:search:${focusedRevision}`,url:location.href,title:scrub(document.title).slice(0,300),text:'Focused native search form only; not page or viewport reading evidence.',elements,computer:{captureBlocked:true,focusBlocked:true,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,links:[]}};
    }catch{return;}
  };
  let lastSnapshotView:'full'|'search-form'='full';
  const snapshot = (mode?:DOMObservationMode): Snapshot => {
    const pending=observer.takeRecords();if (relevant(pending)) version++;focusedMutation(pending);
    if(mode){const focused=focusedSnapshot(mode);if(focused){listenFocusedInput(true);if(lastSnapshotView!=='search-form')version++;lastSnapshotView='search-form';return focused;}}
    // Switching views is a lease change, never a stale full-page acceptance.
    focusedFingerprint=undefined;focusedDependencies.clear();focusedAuxiliaryStyles.clear();
    listenFocusedInput(false);
    lastSnapshotView='full';
    const elements: Snapshot['elements'] = [];
    targets = new Map();
    // Do not clone innerText/outerHTML: both leak form values and hidden secret attributes.
    let visited = 0;
    let text = '';
    const walk = (node: Node) => {
      if(owned(node))return;
      if (++visited > 6000 || text.length >= 12000) return;
      if (node.nodeType === 3) { text += ` ${node.textContent ?? ''}`; return; }
      const el = node as Element;
      const tag = (el.tagName ?? '').toLowerCase();
      if (['script', 'style', 'noscript', 'input', 'textarea', 'select', 'iframe'].includes(tag) || (tag && sensitive(el))) return;
      if (tag) {
        if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
      }
      for (const child of Array.from(node.childNodes ?? [])) walk(child);
      // Fake DOMs and empty leaf elements have no child nodes.
      if (tag && !node.childNodes?.length && el.textContent) text += ` ${el.textContent}`;
    };
    // Prefer document content so site-wide navigation cannot consume the reading budget.
    walk(document.querySelector?.('main, [role="main"], article') ?? document.body);
    for (const el of Array.from(document.querySelectorAll('a[href],button,input,textarea,select,label[for],[role="button"],[role="link"],[role="tab"],[contenteditable="true"]')).slice(0, 2000)) {
      if(owned(el))continue;
      if (elements.length >= 120) break;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!el.isConnected || box.width <= 0 || box.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
      let ref = refs.get(el);
      if (!ref) { ref = `r${++nextRef}`; refs.set(el, ref); }
      const secret = sensitive(el);
      const tag = el.tagName.toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) {
        const input = el as HTMLInputElement;
        // Values stay only in this isolated world's WeakMap, never in the snapshot.
        const live = JSON.stringify([input.value, input.checked, input.disabled, input.readOnly]);
        if (liveValues.has(el) && liveValues.get(el) !== live) version++;
        liveValues.set(el, live);
      }
      const name = secret ? '[sensitive input]' : scrub(el.getAttribute('aria-label') || (tag === 'input' ? el.getAttribute('placeholder') : el.textContent) || '').trim().slice(0, 180);
      elements.push({ ref, tag, role: (el.getAttribute('role') ?? '').slice(0, 40), name, inputType: secret ? 'sensitive' : (el.getAttribute('type') ?? '').slice(0, 32), sensitive: secret, interaction:interaction(el) });
      targets.set(ref, el);
    }
    // Unknown nested documents/shadow trees and excessive DOMs fail closed. No values cross this boundary.
    const nodes=Array.from(document.querySelectorAll('*')).filter(el=>!owned(el));
    const captureBlocked=nodes.length>6000 || nodes.slice(0,6000).some(el=>sensitive(el) || el.tagName.includes('-') || el.getAttribute('type')==='file' || ['IFRAME','FRAME','OBJECT','EMBED'].includes(el.tagName) || !!el.shadowRoot);
    const focused=document.activeElement;
    const computer:Computer={captureBlocked,focusBlocked:!focused || sensitive(focused) || ['IFRAME','FRAME','OBJECT','EMBED'].includes(focused.tagName) || !!focused.shadowRoot,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,links:[]};
    for(const el of Array.from(document.querySelectorAll('a[href]')).slice(0,2000)) {
      if(owned(el))continue;
      if(computer.links.length>=120) break;
      if(el.tagName!=='A' || el.hasAttribute('download') || (el.getAttribute('target') && el.getAttribute('target')!=='_self')) continue;
      const box=el.getBoundingClientRect(), style=getComputedStyle(el);
      if(!el.isConnected || style.display==='none' || style.visibility==='hidden' || box.x<0 || box.y<0 || box.width<=0 || box.height<=0 || box.right>window.innerWidth || box.bottom>window.innerHeight) continue;
      const center=document.elementFromPoint?.(box.x+box.width/2,box.y+box.height/2);
      if(!center || (center!==el && !el.contains(center))) continue;
      const url=(el as HTMLAnchorElement).href;
      if(typeof url==='string' && url.length<=4096) computer.links.push({x:box.x,y:box.y,width:box.width,height:box.height,url});
    }
    const reading=readingViewport();
    const result = { computer, ...(reading?{readingViewport:reading}:{}), stamp: `${documentId}:${version}`, url: location.href, title: scrub(document.title).slice(0, 300), text: scrub(text).replace(/\s+/g, ' ').trim().slice(0, 12000), elements };
    // Captures live value/visibility changes even when no MutationObserver record exists.
    result.stamp += `:${JSON.stringify([result.url, result.title, result.text, result.elements, result.computer, result.readingViewport])}`;
    return result;
  };
  let activeScroll:{jobId?:string;cancel:()=>void} | undefined;
  root.__sideworkDOM = { snapshot, cancelScroll:(jobId) => { if (activeScroll && (jobId === undefined || jobId === activeScroll.jobId)) activeScroll.cancel(); }, act: (command, stamp, options) => {
    const current=snapshot(options?.observation);
    if (current.stamp !== stamp) throw new Error('Stale DOM revision');
    if(current.observationMode==='search-form' && !['click','fill','submit_search'].includes(command.type))throw new Error('Focused search requires a new full observation for this action');
    if (command.type === 'scroll' && options?.smoothScroll === true) {
      const start = window.scrollY;
      const scroller = document.scrollingElement ?? document.documentElement;
      const end = Math.max(0, Math.min(scroller.scrollHeight - window.innerHeight, start + (command.direction === 'up' ? -600 : 600)));
      if (activeScroll) throw new Error('Smooth scroll already active');
      if (end === start || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.scrollTo({left:window.scrollX,top:end,behavior:'instant'});
        version++;
        return Math.abs(window.scrollY-end)<=1 ? Promise.resolve() : Promise.reject(new Error('Smooth scroll final location unverified'));
      }
      return new Promise<void>((resolve, reject) => {
        let frameId = 0, settled = false;
        const documentRoot = document.documentElement;
        const events = ['wheel','pointerdown','touchstart','keydown','pagehide'];
        const interrupt = (event:Event) => { if(event.isTrusted) finish(new Error('Smooth scroll interrupted by trusted input or document unload')); };
        const finish = (error?:Error) => {
          if (settled) return;
          settled = true; cancelAnimationFrame(frameId); clearTimeout(timer); activeScroll = undefined;
          for (const name of events) window.removeEventListener(name,interrupt,true);
          version++;
          if (error) reject(error); else resolve();
        };
        activeScroll = {jobId:options.jobId,cancel:()=>finish(new Error('Smooth scroll cancelled'))};
        for (const name of events) window.addEventListener(name,interrupt,{capture:true,passive:true});
        const timer = setTimeout(()=>finish(new Error('Smooth scroll timeout')),1500);
        const began = performance.now();
        const frame = (now:number) => {
          if (settled) return;
          try {
            if(document.documentElement !== documentRoot || !scroller.isConnected) throw new Error('Smooth scroll document replaced');
            if(now-began>=1500) throw new Error('Smooth scroll timeout');
            const progress = Math.min(1, (now - began) / 700);
            window.scrollTo({left:window.scrollX, top:start + (end-start)*(1-Math.pow(1-progress,3)), behavior:'instant'});
            if (progress < 1) frameId = requestAnimationFrame(frame);
            else if(Math.abs(window.scrollY-end)>1) finish(new Error('Smooth scroll final location unverified'));
            else finish();
          } catch (error) {finish(error instanceof Error ? error : new Error('Smooth scroll location unknown'));}
        };
        try { frameId = requestAnimationFrame(frame); }
        catch (error) {finish(error instanceof Error ? error : new Error('Smooth scroll scheduling failed'));}
      });
    }
    if (command.type === 'scroll') {
      window.scrollBy({ top: command.direction === 'up' ? -600 : 600, behavior: 'instant' });
      version++;
      return;
    }
    const target = targets.get(command.ref ?? '');
    if(command.type==='submit_search') {
      if(current.observationMode!=='search-form' || options?.nativeSearchSubmission!==true || !options?.observation?.scope || !target || sensitive(target) || interaction(target).kind!=='input')throw new Error('Native search submission requires focused query');
      const submit=nativeSubmission(target),input=target as HTMLInputElement;
      if(!submit || !input.value.trim() || input.value.length>4000 || scrub(input.value)!==input.value || Array.from(input.value).some(character=>character.charCodeAt(0)<32 || character.charCodeAt(0)===127) || /(?:password|credential|api[_ -]?key|access[_ -]?token|secret)\s*[:=]/i.test(input.value))throw new Error('Invalid native public query submission');
      HTMLFormElement.prototype.requestSubmit.call(input.form!,submit);
      version++;return;
    }
    if (!target || !target.isConnected || !['click', 'fill'].includes(command.type)) throw new Error('Invalid DOM target');
    if (target.matches(':disabled,[aria-disabled="true"]')) throw new Error('Disabled DOM target');
    if (command.type === 'click') {
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'file') throw new Error('File picker requires user intent');
      (target as HTMLElement).click();
    } else {
      if (sensitive(target)) throw new Error('Sensitive fill is prohibited');
      if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) throw new Error('Target is not a fillable input');
      const input = target as HTMLInputElement | HTMLTextAreaElement;
      if (input.readOnly || (target.tagName === 'INPUT' && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(input.type))) throw new Error('Input type is not fillable');
      const prototype = target.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) throw new Error('Input setter unavailable');
      if(current.observationMode==='search-form') {
        // A native fill includes focusing this already observed query. No global
        // keyboard or pixel capability is used, and focus must not scroll the
        // owned viewport or silently switch the target/document.
        const href=location.href,documentRoot=document.documentElement;
        input.focus({preventScroll:true});
        if(document.activeElement!==input || location.href!==href || document.documentElement!==documentRoot || !input.isConnected || sensitive(input) || input.disabled || input.readOnly || interaction(input).kind!=='input')throw new Error('Focused native input changed before fill');
      }
      setter.call(input, command.value ?? '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    version++;
  } };
}

// esbuild/tsx keepNames may insert __name calls into serialized functions.
// Supply that identity helper inside the isolated script, not from the host scope.
const INSTALL = `(()=>{const __name=(value)=>value;return (${installDOM.toString()})()})()`;
export function actionScript(action: BrowserAction, stamp: string, options?:{nativeSearchSubmission?:boolean;smoothScroll?:boolean;jobId?:string;observation?:DOMObservationMode}): string {
  // JSON is data, not a source template: quotes/backticks in values cannot escape.
  if (!['click', 'fill', 'scroll', 'submit_search'].includes(action.type)) throw new Error('Unsupported DOM action');
  return `${INSTALL};window.__sideworkDOM.act(${JSON.stringify(action)},${JSON.stringify(stamp)},${JSON.stringify(options ?? {})})`;
}

/** Acknowledges the real scroll event/compositor before a new revision is leased. */
export function scrollSettlementScript():string {
  return `new Promise((resolve,reject)=>{const root=document.documentElement,href=location.href;let first=0,second=0,done=false;const events=['wheel','pointerdown','touchstart','keydown','pagehide'];const finish=error=>{if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);for(const name of events)window.removeEventListener(name,interrupt,true);if(error)reject(error);else resolve();};const interrupt=event=>{if(event.isTrusted)finish(new Error('Scroll settlement interrupted'));};const check=()=>{if(document.documentElement!==root||location.href!==href)throw new Error('Scroll settlement document changed');};const timer=setTimeout(()=>finish(new Error('Scroll settlement timed out')),1000);for(const name of events)window.addEventListener(name,interrupt,{capture:true,passive:true});try{first=requestAnimationFrame(()=>{try{check();second=requestAnimationFrame(()=>{try{check();finish();}catch(error){finish(error);}});}catch(error){finish(error);}});}catch(error){finish(error);}})`;
}

export function cancelScrollScript(jobId?:string):string {
  return `window.__sideworkDOM?.cancelScroll(${JSON.stringify(jobId)})`;
}

export function observationScript(mode?:DOMObservationMode): string {
  return `${INSTALL};window.__sideworkDOM.snapshot(${mode?JSON.stringify(mode):''})`;
}
