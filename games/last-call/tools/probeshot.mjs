import { chromium } from 'playwright';
const [,,url,out,expr,w='1100',h='620',frames='18'] = process.argv;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars']});
const p = await b.newPage({viewport:{width:+w,height:+h}});
p.on('pageerror',e=>console.log('ERR:',e.message));
await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
const f=()=>p.evaluate(()=>window.__frameCount||0).catch(()=>0);
for(let i=0;i<200;i++){ if(await f()>=10) break; await p.waitForTimeout(400); }
console.log('mutate:', JSON.stringify(await p.evaluate(expr)));
const start = await f();
for(let i=0;i<200;i++){ if(await f()>=start+ +frames) break; await p.waitForTimeout(400); }
await p.screenshot({path:out});
await b.close();
