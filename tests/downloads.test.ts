import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {mkdtemp,writeFile,rm,unlink,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import { DownloadManager, type DownloadSource } from '../src/desktop/downloads.ts';

class Item extends EventEmitter {
  gesture = true;
  filename = '../unsafe\\report.txt';
  initiator = 'https://example.test';
  state = 'progressing';
  received = 7;
  total = 0;
  path = '';
  cancelled = 0;
  options: Electron.SaveDialogOptions | undefined;
  assigned: string[] = [];
  hasUserGesture() { return this.gesture; }
  getInitiatorOrigin() { return this.initiator; }
  getFilename() { return this.filename; }
  getState() { return this.state; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  getSavePath() { return this.path; }
  setSaveDialogOptions(options: Electron.SaveDialogOptions) { this.options = options; }
  setSavePath(path: string) { this.path = path; this.assigned.push(path); }
  cancel() { this.cancelled++; }
  electron() { return this as unknown as Electron.DownloadItem; }
}
const source: DownloadSource = { profileId: 'p', tabId: 't', url: 'https://example.test/page?secret=token', allowed: true };
function fixture(extra: Partial<ConstructorParameters<typeof DownloadManager>[0]> = {}) {
  let changes = 0;
  let prevented = 0;
  const revealed: string[] = [];
  const manager = new DownloadManager({ downloadsDirectory: '/downloads', onChange: () => { changes++; }, revealFile: path => { revealed.push(path); }, ...extra });
  const event = { preventDefault() { prevented++; } } as Electron.Event;
  return { manager, event, revealed, changes: () => changes, prevented: () => prevented };
}

test('unapproved, automatic and malformed-origin downloads are cancelled before any save dialog',()=>{
 for(const reason of ['automatic','unapproved','malformed'] as const){
  const f=fixture(),item=new Item();if(reason==='automatic')item.gesture=false;
  f.manager.handle(f.event,item.electron(),{...source,allowed:reason!=='unapproved',url:reason==='malformed'?'not a URL':source.url});
  assert.equal(f.prevented(),1);assert.equal(item.cancelled,1);assert.equal(item.options,undefined);assert.deepEqual(item.assigned,[]);
  const [row]=f.manager.getState('p');assert.equal(row.state,'blocked');assert.equal(row.receivedBytes,0);assert(row.error);assert(!JSON.stringify(row).includes('secret=token'));f.manager.dispose();
 }
});

test('native progress and terminal events update real bytes, detach listeners and never expose the saved path',()=>{
 const f=fixture(),item=new Item();f.manager.handle(f.event,item.electron(),source);
 item.received=31;item.total=128;item.emit('updated',{},'progressing');
 let row=f.manager.getState('p')[0]!;assert.equal(row.receivedBytes,31);assert.equal(row.totalBytes,128);
 item.path='/downloads/private-report.txt';item.received=128;item.state='completed';item.emit('done',{},'completed');
 row=f.manager.getState('p')[0]!;assert.equal(row.state,'completed');assert.equal(row.receivedBytes,128);assert.equal(row.totalBytes,128);
 assert(!JSON.stringify(row).includes(item.path));assert.equal(item.listenerCount('updated'),0);assert.equal(item.listenerCount('done'),0);
 item.received=999;item.emit('updated',{},'progressing');assert.equal(f.manager.getState('p')[0]!.receivedBytes,128);f.manager.dispose();assert.equal(item.cancelled,0);
});

test('cancel is profile-bound and records cancellation only after native acknowledgement',()=>{
 const f=fixture(),item=new Item();f.manager.handle(f.event,item.electron(),source);const id=f.manager.getState('p')[0]!.id;
 assert.throws(()=>f.manager.cancel(id,'other'));assert.equal(item.cancelled,0);
 f.manager.cancel(id,'p');assert.equal(item.cancelled,1);assert.equal(f.manager.getState('p')[0]!.state,'progressing');
 f.manager.cancel(id,'p');assert.equal(item.cancelled,1,'Duplicate requests must not repeat native cancel');
 item.state='cancelled';item.emit('done',{},'cancelled');assert.equal(f.manager.getState('p')[0]!.state,'cancelled');
 item.path='/downloads/late.txt';item.emit('done',{},'completed');assert.equal(f.manager.getState('p')[0]!.state,'cancelled');
 assert.throws(()=>f.manager.cancel(id,'p'));f.manager.dispose();assert.equal(item.cancelled,1);
});

test('reveal resolves only an existing completed file owned by the current profile and rejects symlink replacement',async()=>{
 const directory=await mkdtemp(join(homedir(),'.hermes/cache/scratch/sw-download-')),file=join(directory,'saved.txt'),other=join(directory,'other.txt');
 const f=fixture(),item=new Item();try{
  f.manager.handle(f.event,item.electron(),source);const id=f.manager.getState('p')[0]!.id;
  await assert.rejects(()=>f.manager.reveal(id,'p'));await writeFile(file,'fixture bytes');item.path=file;item.emit('done',{},'completed');
  await assert.rejects(()=>f.manager.reveal(id,'other'));assert.deepEqual(f.revealed,[]);
  await f.manager.reveal(id,'p');assert.deepEqual(f.revealed,[file]);
  await unlink(file);await writeFile(other,'replacement');await symlink(other,file);
  await assert.rejects(()=>f.manager.reveal(id,'p'),error=>error instanceof Error&&!error.message.includes(directory));assert.deepEqual(f.revealed,[file]);
 }finally{f.manager.dispose();await rm(directory,{recursive:true,force:true});}
});

test('QA save-path injection is synchronous, opt-in and cannot admit relative paths or forbidden downloads',()=>{
 const seen:string[]=[],f=fixture({qaSavePath:name=>{seen.push(name);return '/qa-owned/'+name;}}),item=new Item();
 f.manager.handle(f.event,item.electron(),source);assert.deepEqual(seen,['report.txt']);assert.deepEqual(item.assigned,['/qa-owned/report.txt']);f.manager.dispose();
 const invalid=fixture({qaSavePath:()=> '../escape.txt'}),bad=new Item();invalid.manager.handle(invalid.event,bad.electron(),source);
 assert.deepEqual(bad.assigned,[]);assert.equal(bad.cancelled,1);assert.equal(invalid.manager.getState('p')[0]!.state,'blocked');invalid.manager.dispose();
 const denied=fixture({qaSavePath:()=>{throw new Error('Must not be invoked');}}),automatic=new Item();automatic.gesture=false;
 assert.doesNotThrow(()=>denied.manager.handle(denied.event,automatic.electron(),source));assert.deepEqual(automatic.assigned,[]);denied.manager.dispose();
});

test('download history and active transfers are bounded and disposal cancels owned items without retaining listeners',()=>{
 const blocked=fixture();for(let i=0;i<130;i++){const item=new Item();item.gesture=false;blocked.manager.handle(blocked.event,item.electron(),source);}
 assert.equal(blocked.manager.getState('p').length,100);blocked.manager.dispose();
 const f=fixture(),items=Array.from({length:9},()=>new Item());for(const item of items)f.manager.handle(f.event,item.electron(),source);
 assert.equal(f.manager.getState('p').filter(row=>row.state==='progressing').length,8);assert.equal(f.manager.getState('p').at(-1)!.state,'blocked');assert.equal(items[8]!.cancelled,1);
 f.manager.dispose();for(const item of items){assert.equal(item.cancelled,1);assert.equal(item.listenerCount('updated'),0);assert.equal(item.listenerCount('done'),0);}
 assert.deepEqual(f.manager.getState('p'),[]);const late=new Item();f.manager.handle(f.event,late.electron(),source);assert.equal(late.cancelled,1);assert.deepEqual(f.manager.getState('p'),[]);
});

test('observer failures and broken native progress do not escape or leak private paths',()=>{
 const f=fixture({onChange:()=>{throw new Error('/private/observer');}}),item=new Item();
 assert.doesNotThrow(()=>f.manager.handle(f.event,item.electron(),source));
 item.getReceivedBytes=()=>{throw new Error('/private/native');};
 assert.doesNotThrow(()=>item.emit('updated',{},'progressing'));
 const row=f.manager.getState('p')[0]!;assert.equal(row.state,'interrupted');assert(row.error);assert(!JSON.stringify(row).includes('/private/'));assert.equal(item.cancelled,1);assert.equal(item.listenerCount('updated'),0);f.manager.dispose();
});

test('owned gesture sets safe native Save options synchronously without preassigning a path', () => {
  const f = fixture();
  const item = new Item();
  f.manager.handle(f.event, item.electron(), source);
  assert.equal(item.options?.defaultPath, '/downloads/report.txt');
  assert.deepEqual(item.assigned, []);
  assert.equal(f.prevented(), 0);
  assert.equal(f.changes(), 1);
  const [download] = f.manager.getState('p');
  assert.equal(download.filename, 'report.txt');
  assert.equal(download.sourceOrigin, 'https://example.test');
  assert.equal(download.receivedBytes, 7);
  assert.equal(download.totalBytes, null);
  assert.equal(download.state, 'progressing');
  assert.equal(download.error, null);
  assert.deepEqual(f.manager.getState('other'), []);
  assert.equal(JSON.stringify(download).includes('secret'), false);
  assert.equal(JSON.stringify(download).includes('/downloads'), false);
  f.manager.dispose();
});
