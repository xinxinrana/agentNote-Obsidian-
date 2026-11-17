import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const { renderExportDocument } = createRequire(import.meta.url)('./core-bundle.cjs');
const binary = process.env.CHROME_BINARY || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-continuous-'));
const browser = spawn(binary, ['--headless', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'browser')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Chromium launch timed out')), 15000);
    browser.on('error', reject);
    browser.stderr.on('data', bytes => { output += bytes; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  const endpoint = new URL(address);
  const tabs = await (await fetch(`http://${endpoint.host}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    if (!value.id) return;
    const job = pending.get(value.id);
    if (job) { pending.delete(value.id); value.error ? job.reject(new Error(JSON.stringify(value.error))) : job.resolve(value.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const bundle = await build({ entryPoints: ['src/continuousPdf.ts'], bundle: true, format: 'iife', globalName: 'continuousPdf', write: false, logLevel: 'silent' });
  const convert = html => evaluate(`(async()=>{${bundle.outputFiles[0].text}\nreturn await continuousPdf.continuousPdfHtml(${JSON.stringify(html)});})()`);
  const makeHtml = count => renderExportDocument({ title: '长页排版检查', sourcePath: 'sample.md', content: '' }, '<div class="markdown-rendered">' + Array.from({ length: count }, (_, index) => `<section><h2>第 ${index + 1} 节</h2><p>连续阅读，内容自然衔接，标题和段落不再被分页截开。</p><table><tr><th>内容</th><th>状态</th></tr><tr><td>第 ${index + 1} 节的完整表格</td><td>保留</td></tr></table></section>`).join('') + '<p>DOCUMENT-END</p></div>', '.sample{color:inherit}');
  for (const [name, count] of [['short', 1], ['long', 24]]) {
    const html = await convert(makeHtml(count));
    assert.match(html, /@page\{size:210mm [\d.]+mm;margin:0\}/);
    assert.equal(await evaluate('document.querySelectorAll(".agentnote-export-measure-frame").length'), 0);
    await evaluate(`document.open();document.write(${JSON.stringify(html)});document.close();`);
    await evaluate('(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images,image=>image.decode()));return true})()');
    const { data } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    const pdf = Buffer.from(data, 'base64');
    const pages = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;
    assert.equal(pages, 1, `${name} PDF must contain exactly one page`);
    if (process.platform === 'darwin') {
      const pdfPath = path.join(directory, `${name}.pdf`);
      await fs.writeFile(pdfPath, pdf);
      const details = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('PDFKit');function run(args){var doc=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args[0]));return JSON.stringify({pages:Number(doc.pageCount),text:ObjC.unwrap(doc.pageAtIndex(0).string)});}", pdfPath], { encoding: 'utf8' }));
      assert.equal(details.pages, 1);
      assert.ok(details.text.replace(/\s/g, '').includes('DOCUMENT-END'), 'Actual PDF text must retain the end of the document');
    }
    if (process.env.AGENTNOTE_PDF_TEST_DIR) {
      await fs.mkdir(process.env.AGENTNOTE_PDF_TEST_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.AGENTNOTE_PDF_TEST_DIR, `${name}.pdf`), pdf);
    }
    console.log(`PASS ${name}: real Chromium PDF has one page, document end retained, measurement frame cleaned`);
    assert.equal(await evaluate('document.querySelector("article").textContent.includes("DOCUMENT-END")'), true);
    await send('Page.navigate', { url: 'about:blank' });
    // Wait for the new document before installing the next measurement frame.
    await evaluate('document.readyState');
  }
  await assert.rejects(convert(makeHtml(500)), /尺寸上限/);
  assert.equal(await evaluate('document.querySelectorAll(".agentnote-export-measure-frame").length'), 0);
  console.log('PASS oversized documents are rejected without truncation or leftover frames');
} finally {
  socket?.close();
  browser.kill();
  await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
