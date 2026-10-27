import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { mkdir } from 'node:fs/promises';
export async function buildDesktop(){
  await mkdir('dist-desktop',{recursive:true});
  await bundle({entryPoints:{main:'src/desktop/main.ts',preload:'src/desktop/preload.ts',worker:'src/bridge/worker.ts'},outdir:'dist-desktop',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:true,logLevel:'info'});
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
  await buildDesktop();
  await buildRenderer();
}
