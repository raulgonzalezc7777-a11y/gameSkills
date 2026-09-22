import { chromium } from 'playwright';
const expr = process.argv[3] || '({})';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR:',e.message));
await p.goto(process.argv[2],{waitUntil:'domcontentloaded',timeout:60000});
for (let i=0;i<40;i++){ const f=await p.evaluate(()=>window.__frameCount||0).catch(()=>0); if(f>6) break; await p.waitForTimeout(500); }
console.log(JSON.stringify(await p.evaluate(expr), null, 2));
await b.close();
