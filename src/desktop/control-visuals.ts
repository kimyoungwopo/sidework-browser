import type { ControlPhase } from '../contract.ts';

// Fixed source, not function.toString(): bundlers must not inject helpers into a
// remote isolated world. Never serialize URLs, prompts, input values or job IDs.
const bootstrap = `(() => {
 if (window.__sideworkVisuals) return;
 const host=document.createElement('div');
 host.setAttribute('aria-hidden','true');
 host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:none;contain:layout style!important;';
 const root=host.attachShadow({mode:'closed'});
 const style=document.createElement('style');
 style.textContent=\`
 :host,*{box-sizing:border-box;pointer-events:none!important}
 .edges{position:absolute;inset:0;background:linear-gradient(90deg,#2377ef88,#38cdef77) top/100% 3px no-repeat,linear-gradient(90deg,#2377ef88,#38cdef77) bottom/100% 3px no-repeat,linear-gradient(90deg,#2377ef40,transparent) left/14px 100% no-repeat,linear-gradient(270deg,#38cdef40,transparent) right/14px 100% no-repeat}
 .pointer{position:absolute;left:0;top:0;display:none;width:64px;height:34px;filter:drop-shadow(0 2px 2px #123f7940)}
 .arrow{position:absolute;width:22px;height:28px;background:#2278ee;clip-path:polygon(0 0,100% 61%,58% 65%,40% 100%)}
 .ai{position:absolute;left:22px;top:16px;padding:1px 4px;border-radius:3px;background:#1459b8;color:white;font:700 10px/1.5 -apple-system,sans-serif}
 .pointer[data-click='true']::after{content:'';position:absolute;left:-9px;top:-9px;width:24px;height:24px;border:2px solid #2e9cfa;border-radius:50%;animation:press .22s ease-out both}
 @keyframes press{from{transform:scale(.5);opacity:1}to{transform:scale(1.5);opacity:0}}
 @media(prefers-reduced-motion:reduce){*,*::after{animation:none!important;transition:none!important}}
 \`;
 const edges=document.createElement('div');edges.setAttribute('class','edges');
 const pointer=document.createElement('div');pointer.setAttribute('class','pointer');
 const arrow=document.createElement('div');arrow.setAttribute('class','arrow');
 const ai=document.createElement('span');ai.setAttribute('class','ai');ai.textContent='AI';
 pointer.append(arrow,ai);root.append(style,edges,pointer);
 // Phase labels live in trusted browser chrome; do not cover website controls.
 const phases=['working','awaiting_approval','moving','clicking','typing','scrolling'];
 let depth=0,active=false;
 let intended=null;
 const render=()=>{host.style.setProperty('display',active && depth===0?'block':'none','important');};
 window.__sideworkVisuals=Object.freeze({
  owns:(node)=>node===host || node===root || root.contains(node),
  set:(phase,x,y)=>{
   if(!phases.includes(phase)) return;
   active=true;
   if(Number.isFinite(x)&&Number.isFinite(y)) {
    pointer.style.transform='translate('+Math.max(0,Math.min(innerWidth-1,x))+'px,'+Math.max(0,Math.min(innerHeight-1,y))+'px)';
    pointer.style.display='block';
   } else pointer.style.display='none';
   pointer.setAttribute('data-click',String(phase==='clicking'));
   render();if(!host.isConnected) document.documentElement.append(host);
  },
  clear:()=>{active=false;render();host.remove();},
  capture:(hidden)=>{depth=hidden?depth+1:Math.max(0,depth-1);render();},
  hit:(x,y,remember)=>{
   if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=innerWidth||y>=innerHeight) return false;
   const node=document.elementFromPoint(x,y);
   if(remember) intended=node;
   return !!intended && intended.isConnected && node===intended;
  }
 });
})()`;

export function controlVisualSetScript(visual:{phase:ControlPhase;x?:number;y?:number}):string {
 const phases:ControlPhase[]=['working','awaiting_approval','moving','clicking','typing','scrolling'];
 if(!phases.includes(visual.phase)) throw new Error('Invalid control phase');
 const coordinate=(value:number|undefined)=>value!==undefined && Number.isFinite(value) && value>=0 && value<=30000?String(value):'undefined';
 return `${bootstrap};window.__sideworkVisuals.set(${JSON.stringify(visual.phase)},${coordinate(visual.x)},${coordinate(visual.y)})`;
}

export function controlVisualClearScript():string {return 'window.__sideworkVisuals?.clear()';}
export function controlVisualCaptureScript(hidden:boolean):string {
 if(!hidden)return 'window.__sideworkVisuals?.capture(false)';
 // DOM display:none is synchronous, but capturePage can reuse the last painted
 // compositor frame. Acknowledge two frames before allowing any model capture.
 // Missing paint acknowledgement fails closed; never fall back to a dirty frame.
 return `${bootstrap};window.__sideworkVisuals.capture(true);new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Control capture paint acknowledgement timeout')),1000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})`;
}
export function controlVisualMotionScript():string {return "matchMedia('(prefers-reduced-motion: reduce)').matches";}
export function controlVisualHitScript(x:number,y:number,remember:boolean):string {
 if(![x,y].every(Number.isFinite) || x<0 || y<0 || x>30000 || y>30000) throw new Error('Invalid pointer hit coordinates');
 return `${bootstrap};window.__sideworkVisuals.hit(${x},${y},${remember===true?'true':'false'})`;
}
