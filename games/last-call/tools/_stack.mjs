import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR:',e.stack));
p.on('console',m=>{ if(m.type()==='error') console.log('CONSOLE:', m.text()); });
p.on('requestfailed', r => console.log('404?', r.url()));
p.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
await p.goto(process.argv[2],{waitUntil:'domcontentloaded',timeout:60000});
await p.waitForTimeout(9000);
await b.close();
