import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNavigation, isAllowedURL, assertJobId, validateTarget, assertBrowserAction } from '../src/desktop/browser-policy.ts';

test('computer actions reject modifiers, nonfinite coordinates, extra flags and oversized data', () => {
  for(const action of [
    {type:'computer_click',x:0,y:1,frameId:'frame'},
    {type:'computer_type',value:'text',frameId:'frame'},
    {type:'computer_key',key:'Space',frameId:'frame'},
  ]) assert.doesNotThrow(()=>assertBrowserAction(action));
  for(const action of [
    {type:'computer_click',x:NaN,y:1,frameId:'frame'},
    {type:'computer_click',x:-1,y:1,frameId:'frame'},
    {type:'computer_click',x:1.1,y:1,frameId:'frame'},
    {type:'computer_click',x:1,y:1,frameId:'frame',autoApproved:true},
    {type:'computer_key',key:'Meta+A',frameId:'frame'},
    {type:'computer_key',key:'Control',frameId:'frame'},
    {type:'computer_type',value:'x'.repeat(12001),frameId:'frame'},
    {type:'computer_type',value:'text',frameId:''},
  ]) assert.throws(()=>assertBrowserAction(action),/action/i);
});

test('browser actions accept only bounded exact typed data and no arbitrary code', () => {
  for (const action of [{ type: 'click', ref: 'r1' }, { type: 'fill', ref: 'r1', value: 'hello' }, { type: 'scroll', direction: 'up' }, { type: 'navigate', url: 'example.com' }, { type: 'observe' }]) assert.doesNotThrow(() => assertBrowserAction(action));
  for (const action of [null, {}, { type: 'evaluate', code: '1+1' }, { type: 'click', ref: 'r1', code: 'bad' }, { type: 'fill', ref: 'r1', value: 'x'.repeat(12001) }, { type: 'scroll', direction: 'sideways' }, { type: 'navigate', url: 'file:///x' }, { type: 'click', ref: '#selector' }]) assert.throws(() => assertBrowserAction(action), /action|navigation/i);
});

test('exact active target, revision and artifact job IDs fail closed', () => {
  const target = { profileId: 'p', tabId: 't', revision: 3 };
  assert.doesNotThrow(() => validateTarget(target, { profileId: 'p', tabId: 't', expectedRevision: 3 }));
  for (const context of [ { profileId: 'other', tabId: 't', expectedRevision: 3 }, { profileId: 'p', tabId: 'other', expectedRevision: 3 }, { profileId: 'p', tabId: 't', expectedRevision: 2 } ]) {
    assert.throws(() => validateTarget(target, context), /target|revision/i);
  }
  for (const id of ['', '../escape', '/abs', '.', 'a/b', 'x'.repeat(129)]) assert.throws(() => assertJobId(id), /job/i);
  assert.doesNotThrow(() => assertJobId('job_123-abc'));
});

test('navigation permits web/owned blank only and searches human text', () => {
  assert.equal(normalizeNavigation('example.com'), 'https://example.com/');
  assert.equal(normalizeNavigation('hello browser'), 'https://www.google.com/search?q=hello%20browser');
  assert.equal(normalizeNavigation('google.com'), 'https://google.com/');
  const koreanSearch = new URL(normalizeNavigation('구글 & C++'));
  assert.equal(koreanSearch.hostname, 'www.google.com');
  assert.equal(koreanSearch.pathname, '/search');
  assert.equal(koreanSearch.searchParams.get('q'), '구글 & C++');
  assert.equal(normalizeNavigation('about:newtab'), 'about:blank');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,a', 'mailto:a@b.com', 'https://u:p@site.test', 'about:config', 'http:\\evil.test']) {
    assert.equal(isAllowedURL(url), false, url);
    assert.throws(() => normalizeNavigation(url), /navigation|URL/i, url);
  }
  assert.equal(isAllowedURL('https://example.com/'), true);
  assert.equal(isAllowedURL('about:blank'), true);
});
