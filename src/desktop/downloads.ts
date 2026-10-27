import type {DownloadItem,Event,SaveDialogOptions} from 'electron';
import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {lstat} from 'node:fs/promises';
import type {BrowserDownload} from '../contract.ts';

export interface DownloadSource {profileId:string;tabId:string;url:string;allowed:boolean;blockedReason?:string}
interface Options {downloadsDirectory:string;onChange:()=>void;revealFile:(path:string)=>void|Promise<void>;qaSavePath?:(filename:string)=>string}
interface Entry {state:BrowserDownload;item:DownloadItem;path:string|null;active:boolean;cancelRequested:boolean;detach:()=>void}
function filename(value:string):string{
 const leaf=Array.from(value.replace(/\\/g,'/').split('/').at(-1)??'').filter(char=>{const code=char.codePointAt(0)!;return code>=32&&code!==127;}).join('').trim().slice(0,200);
 return leaf&&!/^[. ]+$/.test(leaf)?leaf:'download';
}
export class DownloadManager {
 private readonly entries=new Map<string,Entry>();
 private disposed=false;
 constructor(private readonly options:Options){}
 private changed():void{try{this.options.onChange();}catch{/* Observer failures must not escape into native download callbacks. */}}
 handle(event:Event,item:DownloadItem,source:DownloadSource):void{
  if(this.disposed){event.preventDefault();item.cancel();return;}
  const name=filename(item.getFilename());let origin='';
  try{const url=new URL(source.url);if((url.protocol==='http:'||url.protocol==='https:'||url.protocol==='blob:')&&url.origin!=='null')origin=url.origin;}catch{/* Invalid origins remain blocked. */}
  const state:BrowserDownload={id:randomUUID(),profileId:source.profileId,tabId:source.tabId,filename:name,sourceOrigin:origin,state:'progressing',receivedBytes:0,totalBytes:null,startedAt:new Date().toISOString(),error:null};
  while(this.entries.size>=100){const oldest=[...this.entries].find(([,value])=>!value.active);if(!oldest)break;oldest[1].detach();this.entries.delete(oldest[0]);}
  const capacityReached=[...this.entries.values()].filter(value=>value.active).length>=8;
  const entry:Entry={state,item,path:null,active:false,cancelRequested:false,detach:()=>{}};this.entries.set(state.id,entry);
  if(!source.allowed||!item.hasUserGesture()||!origin||capacityReached){
   state.state='blocked';state.error=!source.allowed?source.blockedReason||'이 화면의 다운로드는 허용되지 않았습니다.':capacityReached?'동시 다운로드는 8개까지 가능합니다.':'사용자가 시작한 안전한 페이지의 다운로드만 허용됩니다.';
   event.preventDefault();item.cancel();this.changed();return;
  }
  const settings:SaveDialogOptions={title:'파일 저장',defaultPath:join(this.options.downloadsDirectory,name),properties:['createDirectory','showOverwriteConfirmation']};
  const refresh=()=>{const received=item.getReceivedBytes(),total=item.getTotalBytes();state.receivedBytes=Number.isFinite(received)?Math.max(0,Math.floor(received)):0;state.totalBytes=Number.isFinite(total)&&total>0?Math.floor(total):null;};
  const broken=()=>{entry.active=false;entry.detach();state.state='interrupted';state.error='다운로드 상태를 확인하지 못했습니다.';try{item.cancel();}catch{/* Native state is unknown; never retry automatically. */}this.changed();};
  const updated=(_event:Event,next:'progressing'|'interrupted')=>{if(!entry.active||this.disposed)return;try{refresh();state.state=next;state.error=next==='interrupted'?'다운로드 연결이 중단되었습니다.':null;this.changed();}catch{broken();}};
  const done=(_event:Event,next:'completed'|'cancelled'|'interrupted')=>{
   if(!entry.active||this.disposed)return;
   try{
    refresh();entry.active=false;entry.detach();state.state=next;
    if(next==='completed'){const path=item.getSavePath();if(path&&isAbsolute(path)){entry.path=path;state.filename=filename(path);}else{state.state='interrupted';state.error='저장한 파일의 위치를 확인하지 못했습니다.';}}
    else state.error=next==='interrupted'?'다운로드가 중단되었습니다.':null;
    this.changed();
   }catch{broken();}
  };
  entry.detach=()=>{item.removeListener('updated',updated);item.removeListener('done',done);};
  entry.active=true;item.on('updated',updated);item.once('done',done);
  try{
   item.setSaveDialogOptions(settings);
   if(this.options.qaSavePath){const path=this.options.qaSavePath(name);if(!isAbsolute(path))throw new Error('Invalid QA path');item.setSavePath(path);}
   refresh();
  }catch{
   entry.active=false;entry.detach();state.state='blocked';state.error='다운로드 저장 위치를 준비하지 못했습니다.';event.preventDefault();try{item.cancel();}catch{/* Native item may already be closed. */}
  }
  this.changed();
 }
 getState(profileId:string):BrowserDownload[]{return [...this.entries.values()].filter(entry=>entry.state.profileId===profileId).map(entry=>structuredClone(entry.state));}
 cancel(downloadId:string,profileId:string):void{
  const entry=this.entries.get(downloadId);if(this.disposed||!entry||entry.state.profileId!==profileId||!entry.active)throw new Error('이 다운로드는 취소할 수 없습니다.');
  if(entry.cancelRequested)return;entry.cancelRequested=true;entry.item.cancel();
 }
 async reveal(downloadId:string,profileId:string):Promise<void>{
  const entry=this.entries.get(downloadId),path=entry?.path;
  if(this.disposed||!entry||entry.state.profileId!==profileId||entry.state.state!=='completed'||!path||!isAbsolute(path))throw new Error('완료된 파일만 폴더에서 볼 수 있습니다.');
  try{
   const info=await lstat(path);
   if(this.disposed||this.entries.get(downloadId)!==entry||!info.isFile()||info.isSymbolicLink())throw new Error('Invalid saved file');
   await this.options.revealFile(path);
  }catch{throw new Error('저장한 파일을 확인하지 못했습니다. 파일이 이동되었거나 삭제되었을 수 있습니다.');}
 }
 dispose():void{if(this.disposed)return;this.disposed=true;for(const entry of this.entries.values()){entry.detach();if(entry.active){entry.active=false;if(!entry.cancelRequested)entry.item.cancel();}}this.entries.clear();}
}
