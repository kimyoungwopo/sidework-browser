import type { SplitCount } from '../contract.ts';
export interface PaneBounds { x:number; y:number; width:number; height:number }
export function paneLayout(count: SplitCount, area: {width:number;height:number;left:number;top:number;sidebarWidth:number;bottom:number}): PaneBounds[] {
  if (![1,2,4,8].includes(count)) throw new Error('Invalid split count');
  const columns = Math.min(count,4), rows = Math.ceil(count/columns);
  const width = Math.max(0,area.width-area.left-area.sidebarWidth), height = Math.max(0,area.height-area.top-area.bottom);
  return Array.from({length:count}, (_,i) => {
    const col=i%columns,row=Math.floor(i/columns), x=Math.floor(col*width/columns), y=Math.floor(row*height/rows);
    const header=count>1?32:0;
    return {x:area.left+x,y:area.top+y+header,width:Math.floor((col+1)*width/columns)-x,height:Math.max(0,Math.floor((row+1)*height/rows)-y-header)};
  });
}
