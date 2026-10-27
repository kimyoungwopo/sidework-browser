import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationQueue } from '../src/desktop/operation-queue';

test('browser commands wait for profile initialization and a rejected command does not poison the queue', async () => {
  const queue=new OperationQueue();
  const events:string[]=[];
  let release:()=>void=()=>undefined;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const profile=queue.run(async()=>{events.push('profile:start');await pending;events.push('profile:ready');});
  const navigate=queue.run(async()=>{events.push('navigate');return 7;});
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(events,['profile:start']);
  release();await profile;assert.equal(await navigate,7);assert.deepEqual(events,['profile:start','profile:ready','navigate']);
  await assert.rejects(queue.run(async()=>{throw new Error('expected');}));
  assert.equal(await queue.run(async()=>11),11);
});
