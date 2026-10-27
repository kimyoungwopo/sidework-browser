import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const root=resolve('.');await mkdir('qa/diagnostic',{recursive:true});
const app=await electron.launch({executablePath:require('electron'),args:[root,'--sidework-qa'],env:{...process.env,SIDEWORK_QA:'1',SIDEWORK_DATA_DIR:resolve('qa/diagnostic/data')},timeout:30000});
const logs=[];
app.process().stderr?.on('data',(chunk)=>logs.push(chunk.toString()));
try {
 const page=await app.firstWindow();
 page.on('pageerror',(error)=>logs.push(error.message));page.on('console',(message)=>logs.push(message.type()+': '+message.text()));
 await page.waitForTimeout(3000);
 const pages=app.windows();
 const result={pages:await Promise.all(pages.map(async(p)=>({url:p.url(),bridge:await p.evaluate(()=>typeof window.sidework),text:(await p.locator('body').innerText()).slice(0,200)}))),native:await app.evaluate(({BrowserWindow,webContents})=>({windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),preferences:w.webContents.getLastWebPreferences()})),contents:webContents.getAllWebContents().map(w=>({id:w.id,type:w.getType(),url:w.getURL()}))})),logs};
 console.log(JSON.stringify(result,null,2));await writeFile('qa/diagnostic/result.json',JSON.stringify(result,null,2));
 for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:`qa/diagnostic/window-${i}.png`});
} finally {await app.close();}
