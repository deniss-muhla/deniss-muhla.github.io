const {spawn} = require('child_process');
const puppeteer = require('puppeteer');
const server = spawn(process.cwd() + '/node_modules/.bin/vite', ['preview', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {stdio: ['ignore', 'pipe', 'pipe']});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, launchPromise, interrupted = false;
const serverSettled = new Promise(resolve => {
  server.once('error', resolve);
  server.once('exit', resolve);
});
let notifySignal;
const signal = new Promise(resolve => { notifySignal = resolve; });
for (const name of ['SIGINT', 'SIGTERM']) {
  process.once(name, () => {
    interrupted = true;
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    notifySignal();
  });
}
async function stopChild(child, settled) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([settled, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await settled;
}
async function run() {
const origin = await Promise.race([
  new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    server.once('error', reject);
    server.once('exit', (code, sig) => reject(Error(`preview exited before readiness (${code ?? sig})`)));
  }),
  sleep(30000).then(() => { throw Error('preview did not start'); }),
]);
if (server.exitCode !== null || server.signalCode !== null) throw Error('preview exited before browser launch');
launchPromise=puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args:['--autoplay-policy=no-user-gesture-required']});browser=await launchPromise;if(interrupted)throw Error('interrupted');await browser.defaultBrowserContext().overridePermissions(origin, []);const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',r=>{const u=new URL(r.url());if(u.protocol==='data:'||u.protocol==='blob:'||u.origin===origin)r.continue();else r.abort();});page.on('console',m=>console.log('console:',m.type(),m.text().slice(0,240)));page.on('pageerror',e=>console.log('pageerror:',e.message));let model=[];page.on('response',r=>{if(r.url().includes('Paradee-8M-v1.1'))model.push([r.status(),r.url().split('/').pop()])});await page.evaluateOnNewDocument(()=>{window.__audioStarts=0;window.__audioEvidence=[];window.__workerEvidence=[];const post=Worker.prototype.postMessage;Worker.prototype.postMessage=function(message,...rest){if(message&&(typeof message.text==='string'||message.prepare)){window.__workerEvidence.push({event:'send',id:message.id});this.addEventListener('message',e=>window.__workerEvidence.push({event:'recv',id:e.data?.id,ready:e.data?.ready,error:e.data?.error,length:e.data?.waveform?.length}));this.addEventListener('error',e=>window.__workerEvidence.push({event:'error',message:e.message}));}return post.call(this,message,...rest)};const orig=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...a){window.__audioStarts++;window.__audioEvidence.push({state:this.context.state,sampleRate:this.buffer?.sampleRate,length:this.buffer?.length,nonzero:this.buffer?this.buffer.getChannelData(0).some(v=>v!==0):false});return orig.apply(this,a)}});await page.goto(`${origin}/`,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForSelector('[data-testid="voice-fab"]',{timeout:15000});await page.click('[data-testid="voice-fab"]');await page.waitForSelector('[data-testid="voice-input"]');await page.waitForFunction(()=>window.__workerEvidence.some(e=>e.event==='recv'&&e.id===-1&&e.ready),{timeout:90000});console.log('Paradee prepared before speech smoke');for(const q of ['where did Denis work second','how many workplaces','what was the last workplace','which employers used React']){await page.click('[data-testid="voice-input"]',{clickCount:3});await page.keyboard.press('Backspace');await page.type('[data-testid="voice-input"]',q,{delay:20});await page.waitForFunction(()=>document.querySelectorAll('[data-testid="live-suggestion"]').length===3,{timeout:90000});let names=await page.$$eval('[data-testid="live-suggestion"]',els=>els.map(e=>e.textContent));console.log('query',q,'suggestions',JSON.stringify(names));}const before=await page.evaluate(()=>window.__audioStarts);const choices=await page.$$('[data-testid="live-suggestion"]');await choices[1].click();await page.waitForSelector('[data-testid="voice-replay"]',{timeout:5000});const replay=await page.$$('[data-testid="voice-replay"]');await replay.at(-1).click();try { await page.waitForFunction(n=>window.__audioStarts>n,{timeout:25000},before); } catch(e) { console.log('audio diagnostic',JSON.stringify({before,now:await page.evaluate(()=>window.__audioStarts),models:model,worker:await page.evaluate(()=>window.__workerEvidence)})); throw e; }const evidence=await page.evaluate(()=>window.__audioEvidence);console.log('audio buffer started after suggestion click:',JSON.stringify(evidence),'model responses:',JSON.stringify(model));if(!evidence.some(e=>e.state==='running'&&e.sampleRate===24000&&e.nonzero))throw Error('missing running context or nonzero 24kHz waveform');
}
(async () => {
  const work = run();
  try {
    await Promise.race([work, signal, serverSettled.then(() => { if (!interrupted) throw Error('preview server exited unexpectedly'); })]);
  } finally {
    try {
      if (launchPromise) {
        try { browser = await launchPromise; } catch { /* launch failure is reported by work */ }
      }
      if (browser) {
        const child = browser.process();
        const settled = child && new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else { child.once('exit', resolve); child.once('error', resolve); }
        });
        try {
          await Promise.race([browser.close(), sleep(3000)]);
        } finally {
          if (child) await stopChild(child, settled);
        }
      }
    } finally {
      await stopChild(server, serverSettled);
      if (interrupted) await work.catch(() => {});
    }
  }
})().catch(error => { console.error(error.stack); if (!interrupted) process.exitCode = 1; });
