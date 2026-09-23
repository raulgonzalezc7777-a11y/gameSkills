import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:640,height:360}});
const lines=[];
p.on('console',m=>lines.push(m.text()));
p.on('pageerror',e=>lines.push('PAGEERROR '+e.message));
await p.goto(process.argv[2],{waitUntil:'domcontentloaded',timeout:60000});
for(let i=0;i<200;i++){ const f=await p.evaluate(()=>window.__frameCount||0).catch(()=>0); if(f>=8) break; await p.waitForTimeout(400); }
const joined = lines.join('\n');
const idx = joined.indexOf('ERROR:');
if (idx >= 0) console.log(joined.slice(Math.max(0, idx-2500), idx+700));
else console.log('no GLSL ERROR found. console lines:', lines.length, '\n', joined.slice(0,1500));
await b.close();
