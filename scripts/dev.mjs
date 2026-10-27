import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildDesktop } from './build.mjs';
const require=createRequire(import.meta.url);
await buildDesktop();
const server=await createServer({server:{host:'127.0.0.1',port:5187,strictPort:true,open:false}});
await server.listen();
const child=spawn(require('electron'),['.'],{stdio:'inherit',env:{...process.env,SIDEWORK_DEV_URL:'http://127.0.0.1:5187/'}});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');await server.close();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
child.on('exit',async(code)=>{await stop();process.exitCode=code??1;});
console.log('Sidework development UI: http://127.0.0.1:5187/ (task-owned; no automatic Chrome tab)');
