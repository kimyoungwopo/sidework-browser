import type { BrowserAction, Observation, SafeScreenLink, ScreenFrame } from './contract';
const risky=/(?:delete|remove|destroy|submit|send|pay|purchase|checkout|cart|order|logout|login|sign[-_]?in|auth|token|secret|credential|password|unsubscribe|결제|삭제|전송|제출|로그인|인증)/i;
export function isSafeNavigation(currentUrl:string,targetUrl:string):boolean{
 try{const from=new URL(currentUrl),to=new URL(targetUrl);if(!['http:','https:'].includes(from.protocol)||!['http:','https:'].includes(to.protocol)||from.origin!==to.origin||to.username||to.password)return false;
 const resource=decodeURIComponent(to.pathname+to.search+to.hash);return !risky.test(resource)&&!Array.from(to.searchParams.keys()).some(key=>/^(code|state|session|key)$/i.test(key));}catch{return false;}
}
export function screenLinkAt(frame:ScreenFrame,x:number,y:number):SafeScreenLink|undefined{
 if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=frame.width||y>=frame.height)return undefined;
 const matches=frame.safeLinks.filter(link=>Number.isFinite(link.x)&&Number.isFinite(link.y)&&Number.isFinite(link.width)&&Number.isFinite(link.height)&&link.width>0&&link.height>0&&x>=link.x&&y>=link.y&&x<link.x+link.width&&y<link.y+link.height);
 return matches.length===1?matches[0]:undefined;
}
export function isAutomaticComputerAction(action:BrowserAction,observation:Observation):boolean{
 switch(action.type){
  case 'observe':case 'scroll':case 'screenshot':return true;
  case 'navigate':return isSafeNavigation(observation.url,action.url);
  case 'computer_click':{
   const screen=observation.screen;if(!screen||screen.frameId!==action.frameId)return false;
   const link=screenLinkAt(screen,action.x,action.y);return link!==undefined&&isSafeNavigation(observation.url,link.url);
  }
  default:return false;
 }
}
