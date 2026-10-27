import test from 'node:test';
import assert from 'node:assert/strict';
import { cliPath } from '../src/desktop/environment';

test('Finder-style PATH can find an explicitly installed CLI Node runtime without cwd or duplicate entries',()=>{
 const paths=cliPath('/Users/qa','/usr/bin:/bin::/usr/bin').split(':');
 assert.deepEqual(paths,['/Users/qa/.local/bin','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin']);
 assert(!paths.includes(''));assert(cliPath('/Users/qa',undefined).includes('/Users/qa/.local/bin'));
});
