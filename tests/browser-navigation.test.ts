import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationErrorMessage } from '../src/desktop/browser-policy';
test('cancelled navigation is not a page failure but real connection errors are visible without full URLs',()=>{
 assert.equal(navigationErrorMessage(-3,'ERR_ABORTED'),null);
 assert.equal(navigationErrorMessage(-3,''),null);
 assert.match(navigationErrorMessage(-105,'ERR_NAME_NOT_RESOLVED')??'',/ERR_NAME_NOT_RESOLVED/);
 assert.match(navigationErrorMessage(-2,'https://private.example/?token=fixture')??'',/네트워크 오류/);
 assert(!(navigationErrorMessage(-2,'https://private.example/?token=fixture')??'').includes('token'));
});
