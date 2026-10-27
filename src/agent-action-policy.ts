import type { AgentScope, BrowserAction, Observation } from './contract.ts';
import { isSafeNavigation } from './computer-policy.ts';
import {goalScopeAllows,isAutomaticGoalNavigation} from './goal-navigation';

/** Routine controls only: this cannot prove arbitrary-site handlers have no side effects.
 * The caller must additionally bind areaId to the live agent-owned area and job.
 */
export function isAutomaticAgentAction(action:BrowserAction,observation:Observation,scope:AgentScope,now=Date.now()):boolean {
 try {
  if(!scope || typeof scope.areaId!=='string' || typeof scope.origin!=='string' || scope.origin.length>2048 || typeof scope.expiresAt!=='string' || scope.expiresAt.length>64 || scope.expiresAt!==scope.expiresAt.trim())return false;
  const origin=new URL(scope.origin),page=new URL(observation.url),expires=Date.parse(scope.expiresAt);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.areaId) || origin.origin!==scope.origin || !['http:','https:'].includes(origin.protocol) || !goalScopeAllows(scope,observation.url) || page.username || page.password || !Number.isFinite(now) || !Number.isFinite(expires) || expires<=now || expires-now>3600000)return false;
  switch(action.type) {
   case 'observe':case 'scroll':case 'screenshot':return true;
   case 'navigate':return isSafeNavigation(observation.url,action.url)||isAutomaticGoalNavigation(scope,action.url);
   case 'click':case 'fill':case 'submit_search': {
    if(!/^r[1-9]\d{0,15}$/.test(action.ref))return false;
    const matches=observation.elements.filter(element=>element.ref===action.ref);
    if(matches.length!==1)return false;
    const target=matches[0],metadata=target.interaction;
    if(target.sensitive!==false || !metadata || /delete|remove|destroy|submit|send|pay|purchase|checkout|cart|order|logout|login|log[-_ ]?in|sign[-_ ]?(?:in|up|out)|auth|token|secret|credential|password|unsubscribe|publish|upload|download|permission|grant|revoke|allow|confirm|approve|subscribe|결제|삭제|전송|제출|로그인|인증|권한|게시|발행|구매|가입/i.test(target.name))return false;
    if(action.type==='submit_search') {
     const binding=metadata.submission;
     return !!scope.goalId && scope.allowedOrigins?.includes('https://www.naver.com')===true && scope.allowedOrigins.includes('https://search.naver.com') && observation.url==='https://www.naver.com/' && observation.observationMode==='search-form' && typeof observation.documentId==='string' && !!observation.documentId && target.tag==='input' && target.role==='combobox' && target.inputType==='search' && metadata.kind==='input' && binding?.kind==='naver-native-get' && binding.method==='get' && binding.url==='https://search.naver.com/search.naver' && Object.keys(binding).length===3;
    }
    if(action.type==='fill')return metadata.kind==='input' && ['input','textarea'].includes(target.tag) && ['','text','search','email','url','tel','number'].includes(target.inputType) && typeof action.value==='string' && action.value.length<=4000 && Array.from(action.value).every(character=>{const code=character.charCodeAt(0);return code===9||code===10||code===13||(code>=32&&code!==127);});
    if(metadata.kind==='local')return (target.tag==='input' && ['checkbox','radio'].includes(target.inputType)) || target.role==='tab' || (target.tag==='button' && target.inputType==='button');
    if(metadata.kind==='navigation' || metadata.kind==='search')return typeof metadata.url==='string' && metadata.url.length<=2048 && (isSafeNavigation(observation.url,metadata.url)||isAutomaticGoalNavigation(scope,metadata.url));
    return false;
   }
   default:return false;
  }
 } catch {return false;}
}
