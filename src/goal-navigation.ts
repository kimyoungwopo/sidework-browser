import type {AgentScope} from './contract';
import {isSafeNavigation} from './computer-policy';

/** Lexical public-web guard, not a DNS/network-egress isolation claim. */
export function assertPublicGoalUrl(raw:string):URL {
 if(typeof raw!=='string'||!raw||raw.length>4096||raw!==raw.trim()||Array.from(raw).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new Error('작업 주소가 올바르지 않습니다.');
 const url=new URL(raw),host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!host.includes('.')||host.startsWith('[')||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|invalid|onion)$/.test(host))throw new Error('AI 새 작업은 공개 웹 주소만 열 수 있습니다.');
 const decoded=decodeURIComponent(url.pathname+url.search+url.hash);
 if(Array.from(decoded).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)||[...url.searchParams.keys()].some(key=>/token|secret|password|session|credential|^(?:code|state|key|api_key|otp)$/i.test(key))||/(?:token|secret|password|session|credential|code|api_key)\s*=/i.test(decodeURIComponent(url.hash))||/(?:^|\/)(?:delete|remove|destroy|logout|sign[-_]?out|pay|purchase|checkout|cart|order|submit|send|publish|upload|download)(?:\/|$|[?&#=])/i.test(decoded))throw new Error('민감하거나 상태를 변경할 수 있는 시작 주소는 열지 않습니다.');
 return url;
}

export function goalScopeAllows(scope:AgentScope,raw:string):boolean {
 try{
  if(scope.goalId===undefined&&scope.allowedOrigins===undefined)return new URL(raw).origin===scope.origin;
  if(!scope.goalId||!scope.allowedOrigins?.includes(scope.origin))return false;
  return scope.allowedOrigins.includes(assertPublicGoalUrl(raw).origin);
 }catch{return false;}
}

export function isAutomaticGoalNavigation(scope:AgentScope,raw:string):boolean {
 return !!scope.goalId&&goalScopeAllows(scope,raw)&&isSafeNavigation(raw,raw);
}
