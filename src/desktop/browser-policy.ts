import type { BrowserContext, BrowserAction } from '../contract.ts';

export function assertJobId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid job ID');
}

export function validateTarget(target: BrowserContext & { revision: number }, context: BrowserContext & { expectedRevision?: number }): void {
  if (target.profileId !== context.profileId || target.tabId !== context.tabId) throw new Error('Browser target changed');
  if (context.expectedRevision !== undefined && context.expectedRevision !== target.revision) throw new Error('Stale browser revision');
}

export function assertBrowserAction(value: unknown): asserts value is BrowserAction {
  if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') throw new Error('Invalid browser action');
  const keys: Record<string, string[]> = { navigate: ['type', 'url'], open_tab: ['type', 'url'], click: ['type', 'ref'], submit_search: ['type', 'ref'], fill: ['type', 'ref', 'value'], scroll: ['type', 'direction'], observe: ['type'], screenshot: ['type'], computer_click:['type','x','y','frameId'], computer_type:['type','value','frameId'], computer_key:['type','key','frameId'] };
  const allowed = keys[value.type];
  if (!allowed || Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Invalid browser action keys');
  if(value.type.startsWith('computer_')) {
    const action=value as Record<string,unknown>;
    if(typeof action.frameId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(action.frameId)) throw new Error('Invalid computer action frame');
    if(value.type==='computer_click' && (![action.x,action.y].every(n=>typeof n==='number' && Number.isSafeInteger(n) && n>=0 && n<=30000))) throw new Error('Invalid computer action coordinates');
    if(value.type==='computer_type' && (typeof action.value!=='string' || action.value.length>12000)) throw new Error('Invalid computer action text');
    if(value.type==='computer_key' && !['Tab','Enter','Escape','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Space'].includes(String(action.key))) throw new Error('Invalid computer action key');
  }
  if (value.type === 'navigate' || value.type === 'open_tab') {
    if (!('url' in value) || typeof value.url !== 'string' || value.url.length > 4096) throw new Error('Invalid browser action URL');
    normalizeNavigation(value.url);
  }
  if (value.type === 'click' || value.type === 'fill' || value.type === 'submit_search') {
    if (!('ref' in value) || typeof value.ref !== 'string' || !/^r[1-9]\d{0,9}$/.test(value.ref)) throw new Error('Invalid browser action ref');
  }
  if (value.type === 'fill' && (!('value' in value) || typeof value.value !== 'string' || value.value.length > 12000)) throw new Error('Invalid browser action fill');
  if (value.type === 'scroll' && (!('direction' in value) || !['up', 'down'].includes(String(value.direction)))) throw new Error('Invalid browser action scroll');
}

/** Only app-owned blank pages and credential-free HTTP(S) pages may load. */
export function isAllowedURL(value: string): boolean {
  if (value === 'about:blank') return true;
  if (!/^https?:\/\//i.test(value) || (value.includes('\\') || [...value].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127))) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** ERR_ABORTED means the request was superseded/stopped, not that the visible page failed. */
export function navigationErrorMessage(code: number, description: string): string | null {
  if (code === -3) return null;
  const reason = /^ERR_[A-Z_]+$/.test(description) ? description : '네트워크 오류';
  return `페이지를 불러오지 못했습니다 (${reason}). 주소와 연결 상태를 확인하세요.`;
}

export function normalizeNavigation(raw: string): string {
  const value = raw.trim();
  if (!value || value === 'about:newtab' || value === 'about:blank') return 'about:blank';
  if (isAllowedURL(value)) return new URL(value).href;
  // A scheme is never reinterpreted as a search or repaired into another protocol.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || (value.includes('\\') || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) throw new Error('Unsafe navigation URL');
  if (/^(localhost|[\w.-]+\.[a-z]{2,})(:\d+)?(\/.*)?$/i.test(value)) {
    const url = `https://${value}`;
    if (isAllowedURL(url)) return new URL(url).href;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
