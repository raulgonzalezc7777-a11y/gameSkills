import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [,,url,out,expr,w='1000',h='600'] = process.argv;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars']});
const p = await b.newPage({viewport:{width:+w,height:+h}});
p.on('pageerror',e=>console.log('ERR:',e.message));
await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
for(let i=0;i<200;i++){ const f=await p.evaluate(()=>window.__frameCount||0).catch(()=>0); if(f>=12) break; await p.waitForTimeout(400); }
const data = await p.evaluate(async (expr) => {
  const G = window.__game;
  const fn = new Function('G', 'return (async()=>{' + expr + '})()');
  const info = await fn(G);
  G.camera.updateMatrixWorld(true); G.camera.updateProjectionMatrix();
  G.renderer.setRenderTarget(null);
  G.renderer.render(G.scene, G.camera);
  return { url: G.renderer.domElement.toDataURL('image/png'), info };
}, expr);
console.log('info:', JSON.stringify(data.info));
writeFileSync(out, Buffer.from(data.url.split(',')[1], 'base64'));
await b.close();
