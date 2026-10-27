import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

function page(reduced=false) {
 const roots:FakeNode[]=[];
 class FakeNode {
  children:FakeNode[]=[];parent:FakeNode|undefined; style={cssText:'',display:'',transform:'',priorities:{} as Record<string,string>,setProperty(name:string,value:string,priority:string){Object.assign(this,{[name]:value});this.priorities[name]=priority;}};textContent='';attrs:Record<string,string>={};shadow:FakeNode|undefined;
  constructor(public tagName='DIV'){}
  append(...nodes:FakeNode[]){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
  contains(n:FakeNode):boolean{return this===n || this.children.some(c=>c.contains(n));}
  remove(){if(this.parent) this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=undefined;}
  setAttribute(k:string,v:string){this.attrs[k]=v;}
  attachShadow(options:{mode:string}){assert.equal(options.mode,'closed');this.shadow=new FakeNode('SHADOW');return this.shadow;}
  get isConnected():boolean{return !!this.parent;}
 }
 const root=new FakeNode('HTML');
 const world=vm.createContext({window:{},document:{documentElement:root,createElement:(tag:string)=>{const n=new FakeNode(tag);roots.push(n);return n;}},requestAnimationFrame:(fn:(time:number)=>void)=>{queueMicrotask(()=>fn(0));return 1;},setTimeout,clearTimeout,matchMedia:()=>({matches:reduced}),innerWidth:800,innerHeight:600});
 return {world,root,roots,FakeNode};
}

test('isolated visual host owns real closed-tree identity without touching page text or accepting user markup',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts');
 const p=page();
 vm.runInContext(scripts.controlVisualSetScript({phase:'working'}),p.world);
 const host=p.root.children[0]!;
 assert.equal(host.attrs['aria-hidden'],'true');
 assert.match(host.style.cssText,/pointer-events:\s*none/);
 assert.equal(host.shadow!.children.at(-1)!.children.at(-1)!.textContent,'AI');
 assert.match(host.shadow!.children[0]!.textContent,/linear-gradient/);
 assert.equal(host.textContent,'');
 const owns=(node:unknown)=>{p.world.node=node;return vm.runInContext('window.__sideworkVisuals.owns(node)',p.world);};
 assert.equal(owns(host),true);assert.equal(owns(host.shadow!.children.at(-1)),true);
 const impostor=new p.FakeNode();impostor.attrs={...host.attrs};assert.equal(owns(impostor),false);
 assert.equal(owns(p.root),false);
 assert.doesNotMatch(scripts.controlVisualSetScript({phase:'working'}),/ipcRenderer|require\(|innerHTML/);
});

test('native chrome phase does not duplicate a floating status banner over page content',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts'),p=page();
 vm.runInContext(scripts.controlVisualSetScript({phase:'working'}),p.world);
 const host=p.root.children[0]!;
 assert.equal(host.shadow!.children.some(node=>node.attrs.class==='status'),false);
 assert.equal(host.shadow!.children.some(node=>node.attrs.class==='edges'),true);
 assert.equal(host.shadow!.children.some(node=>node.attrs.class==='pointer'),true);
 assert.doesNotMatch(host.shadow!.children[0]!.textContent,/\.status\s*\{/);
});

test('pointer target validation compares original hit element identity even when only CSS hit testing changes',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts');const p=page();
 const intended=new p.FakeNode('BUTTON'),cover=new p.FakeNode('DIV');p.root.append(intended,cover);
 p.world.hit=intended;vm.runInContext('document.elementFromPoint=()=>hit',p.world);
 assert.equal(vm.runInContext(scripts.controlVisualHitScript(20,30,true),p.world),true);
 assert.equal(vm.runInContext(scripts.controlVisualHitScript(20,30,false),p.world),true);
 p.world.hit=cover;
 assert.equal(vm.runInContext(scripts.controlVisualHitScript(20,30,false),p.world),false);
 p.world.hit=intended;intended.remove();
 assert.equal(vm.runInContext(scripts.controlVisualHitScript(20,30,false),p.world),false);
});

test('native capture waits for two compositor frames after hiding control feedback',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts');const p=page();
 const frames:((time:number)=>void)[]=[];p.world.requestAnimationFrame=(fn:(time:number)=>void)=>{frames.push(fn);return frames.length;};
 vm.runInContext(scripts.controlVisualSetScript({phase:'working'}),p.world);
 const captured=vm.runInContext(scripts.controlVisualCaptureScript(true),p.world) as Promise<void>|undefined;
 assert.equal(typeof captured?.then,'function','Capture must acknowledge compositor flush, not only synchronous DOM hide');
 let ready=false;void captured!.then(()=>{ready=true;});assert.equal(p.root.children[0]!.style.display,'none');
 assert.equal(ready,false);frames.shift()!(0);await Promise.resolve();assert.equal(ready,false);
 frames.shift()!(0);await captured;assert.equal(ready,true);
});

test('capture before first feedback installation also hides any installation arriving during capture',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts');const p=page();
 vm.runInContext(scripts.controlVisualCaptureScript(true),p.world);
 vm.runInContext(scripts.controlVisualSetScript({phase:'working'}),p.world);
 assert.equal(p.root.children[0]!.style.display,'none');
 vm.runInContext(scripts.controlVisualCaptureScript(false),p.world);
 assert.equal(p.root.children[0]!.style.display,'block');
});

test('nested capture hides updates until the last restore and clear cannot be undone by finally',async()=>{
 const scripts=await import('../src/desktop/control-visuals.ts');const p=page();
 const run=(code:string)=>vm.runInContext(code,p.world);
 run(scripts.controlVisualSetScript({phase:'working'}));const host=p.root.children[0]!;
 run(scripts.controlVisualCaptureScript(true));run(scripts.controlVisualCaptureScript(true));
 run(scripts.controlVisualSetScript({phase:'moving',x:20,y:30}));
 assert.equal(host.style.priorities.display,'important','Author page CSS must not force model-visible feedback');
 assert.equal(host.style.display,'none');run(scripts.controlVisualCaptureScript(false));
 assert.equal(host.style.display,'none');run(scripts.controlVisualCaptureScript(false));
 assert.equal(host.style.display,'block');
 run(scripts.controlVisualCaptureScript(true));run(scripts.controlVisualClearScript());
 run(scripts.controlVisualCaptureScript(false));assert.equal(host.style.display,'none');assert.equal(host.isConnected,false);
 p.world.retired=host;assert.equal(vm.runInContext('window.__sideworkVisuals.owns(retired)',p.world),true,'Queued removal records retain genuine ownership');
});
