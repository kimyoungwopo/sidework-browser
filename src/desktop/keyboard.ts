export function browserShortcut(input: { type: string; key: string; meta: boolean; control: boolean }): 'L'|'T'|'J'|null {
 if(input.type!=='keyDown'||(!input.meta&&!input.control))return null;
 const key=input.key.toUpperCase();return key==='L'||key==='T'||key==='J'?key:null;
}
