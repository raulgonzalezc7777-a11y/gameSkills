import { chromium } from 'playwright';
const [,,url,out,w='1600',h='900',waitMs='4000'] = process.argv;
const b = await chromium.launch({
  executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist',
        '--enable-webgl','--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars']
});
const p = await b.newPage({ viewport:{width:+w,height:+h}, deviceScaleFactor:1 });
const logs=[]; p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`)); p.on('pageerror',e=>logs.push(`[pageerror] ${e.message}`));
await p.goto(url,{waitUntil:'networkidle',timeout:60000});
await p.waitForTimeout(+waitMs);
await p.evaluate(()=>window.__ready).catch(()=>{});
const info = await p.evaluate(()=>({ok:window.__ok,done:window.__done}));
await p.screenshot({path:out});
console.log(JSON.stringify(info));
console.log(logs.slice(0,40).join('\n'));
await b.close();
