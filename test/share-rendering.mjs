import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
const require = createRequire(import.meta.url);
const { VaultStore, AgentServer, prepareShareMarkdown, imageMime } = require('./core-bundle.cjs');
const dom = new JSDOM('<!doctype html><body></body>');
dom.window.HTMLElement.prototype.createDiv = function(options = {}) { const el = dom.window.document.createElement('div'); el.className = options.cls || ''; this.append(el); return el; };
let active = 0;
let failure = false;
const calls = [];
class Component {}
const parent = { addChild(child) { active++; return child; }, removeChild() { active--; } };
const obsidian = {
  Component,
  parseLinktext(link) { return { path: link.split('#')[0] }; },
  MarkdownRenderer: { async render(app, markdown, host, sourcePath) {
    calls.push({ markdown, sourcePath });
    assert.doesNotMatch(markdown, /```|~~~|!\[\[|dataviewjs|<script>|dv\.pages/);
    if (failure) throw new Error('renderer failed');
    host.innerHTML = new MarkdownIt({ html: true }).render(markdown);
  } },
};
const bundle = await build({ entryPoints: ['src/shareRenderer.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false, logLevel: 'silent' });
const exported = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module: exported, exports: exported.exports, require: name => name === 'obsidian' ? obsidian : require(name), document: dom.window.document });
const { createShareRenderer, cleanShareHtml, readShareImage } = exported.exports;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-render-'));
const root = path.join(temp, 'vault');
await fs.mkdir(path.join(root, 'Notes/assets'), { recursive: true });
await fs.mkdir(path.join(root, 'Other'), { recursive: true });
await fs.mkdir(path.join(root, '.obsidian'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
for (const name of ['Notes/assets/好 软件.png', 'Notes/assets/a#b.png', '.obsidian/private.png']) await fs.writeFile(path.join(root, name), png);
const otherPng = Buffer.concat([png, Buffer.from('other')]);
await fs.writeFile(path.join(root, 'Other/好 软件.png'), otherPng);
await fs.writeFile(path.join(temp, 'outside.png'), png);
await fs.symlink(path.join(temp, 'outside.png'), path.join(root, 'Notes/assets/outside.png'));
let imageReads = 0;
const resolutions = [];
const app = { vault: { configDir: '.obsidian' }, metadataCache: { getFirstLinkpathDest(link, sourcePath) {
  resolutions.push([link, sourcePath]);
  const candidates = [path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), link)), link, `Notes/assets/${link}`, `Other/${link}`];
  const found = candidates.find(candidate => require('node:fs').existsSync(path.join(root, candidate)));
  return found ? { path: found } : null;
} } };
const store = new VaultStore(root, '.obsidian', { deviceIdFile: path.join(temp, 'device'), referencesFile: path.join(temp, 'refs') });
const server = new AgentServer(store, { port: 0, renderMarkdown: createShareRenderer(app, parent), readImage: async (...args) => { imageReads++; return readShareImage(app, root, ...args); } });
const base = `http://127.0.0.1:${await server.start()}`;
const url = id => `${base}/api/shares/${id}/resolve`;
const imageUrl = (id, link) => `${base}/api/shares/${id}/image?link=${encodeURIComponent(link)}`;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const file = 'Notes/demo.md';
  const snippet = '![[好 软件.png|320x200]]\n\n![200](assets/a%23b.png)';
  const content = '# Demo\n\n> [!note]\n> Callout\n\n' + snippet + '\n\n![[Other/好 软件.png]]\n\n![[Secret note]]\n\n```dataviewjs\napp.vault.delete(secret)\n```\n\n`![[code.png]]`\n\n`$= dv.pages()`\n\n<script>alert(1)</script>';
  await fs.writeFile(path.join(root, file), content);
  const share = await store.createPathShare(file);
  const selection = await store.createPathShare(file, '', snippet);
  await test('HTTP page calls the host renderer, preserves dimensions and serves exact image bytes', async () => {
    const response = await fetch(url(share.id));
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
    const page = new JSDOM(await response.text()).window.document;
    const images = [...page.querySelectorAll('article img')];
    assert.equal(images.length, 3);
    assert.equal(images[0].getAttribute('width'), '320');
    assert.equal(images[0].getAttribute('height'), '200');
    assert.equal(images[1].getAttribute('width'), '200');
    const readsBeforeImages = (await store.getDashboardInsights()).summary.weekResolves;
    for (const image of images) {
      const result = await fetch(base + image.getAttribute('src'));
      assert.equal(result.status, 200, image.getAttribute("src"));
      assert.equal(result.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), new URL(image.getAttribute("src"), base).searchParams.get("link").startsWith("Other/") ? otherPng : png);
    }
    assert.equal((await store.getDashboardInsights()).summary.weekResolves, readsBeforeImages);
    assert.equal(calls.at(-1).sourcePath, file);
    assert.ok(resolutions.some(([link, source]) => link === '好 软件.png' && source === file));
    assert.match(response.headers.get('content-security-policy'), /img-src 'self'/);
    assert.match(page.querySelector('article').textContent, /!\[\[Secret note\]\]/);
    assert.match(page.querySelector('article code.language-dataviewjs').textContent, /app.vault.delete/);
    assert.equal(page.querySelector('article script'), null);
    assert.equal(page.querySelector('article p pre'), null);
    assert.equal(active, 0);
    assert.equal(dom.window.document.body.children.length, 0);
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
  });
  await test('selection allows only its images; arbitrary paths and code-only references never reach disk', async () => {
    const before = imageReads;
    for (const link of ['Other/好 软件.png', 'code.png', '../../outside.png', '.obsidian/private.png', 'file:///tmp/a.png', 'https://example.com/a.png']) {
      assert.equal((await fetch(imageUrl(selection.id, link))).status, 404, link);
    }
    assert.equal(imageReads, before);
    assert.equal((await fetch(imageUrl(selection.id, '好 软件.png'))).status, 200);
    const page = await (await fetch(url(selection.id))).text();
    assert.doesNotMatch(page, /Secret note|app.vault.delete|Other%2F/);
  });
  await test('hidden attachments and symlinks escaping the vault are refused even when referenced', async () => {
    await fs.writeFile(path.join(root, 'Notes/private.md'), '![[.obsidian/private.png]]\n\n![[assets/outside.png]]');
    const privateShare = await store.createPathShare('Notes/private.md');
    assert.equal((await fetch(imageUrl(privateShare.id, '.obsidian/private.png'))).status, 404);
    assert.equal((await fetch(imageUrl(privateShare.id, 'assets/outside.png'))).status, 404);
    await fs.mkdir(path.join(root, 'custom-config'), { recursive: true });
    await fs.writeFile(path.join(root, 'custom-config/private.png'), png);
    app.vault.configDir = 'custom-config';
    assert.equal(await readShareImage(app, root, 'custom-config/private.png', file), null);
    app.vault.configDir = '.obsidian';
  });
  await test('removing an image from the shared text removes access without a stale allowlist', async () => {
    await fs.writeFile(path.join(root, file), '# No images');
    assert.equal((await fetch(imageUrl(share.id, '好 软件.png'))).status, 404);
    assert.equal((await fetch(imageUrl(selection.id, '好 软件.png'))).status, 410);
    assert.equal((await fetch(imageUrl('s-x-not-existing', '好 软件.png'))).status, 404);
  });
  await test('parser respects inline/fenced code, reference images and escaping', async () => {
    assert.equal(imageMime('constructor'), undefined);
    assert.equal(imageMime('toString'), undefined);
    assert.equal(prepareShareMarkdown('![[constructor]]').slots.some(s => s.image), false);
    const prepared = prepareShareMarkdown('`![[hidden.png]]`\n\n~~~js\n![[hidden2.png]]\n~~~\n\n\\![[escaped.png]]\n\n![x][photo]\n\n[photo]: assets/a%23b.png');
    assert.deepEqual(prepared.slots.filter(s => s.image).map(s => s.image.link), ['assets/a#b.png']);
  });
  await test('static HTML keeps callout semantics and strips executable markup, host UI and local paths', async () => {
    const host = dom.window.document.createElement('div');
    host.innerHTML = '<div class="callout" data-callout="note" onclick="evil()"><div class="callout-title">Title</div><p>Body</p><svg><script>evil()</script></svg><img src="app://local/private.png"><iframe src="https://evil.invalid"></iframe><button>Copy</button><a href="javascript:evil()">bad</a><a href="app://secret">local</a><input type="checkbox" checked><input type="text"></div>';
    const html = cleanShareHtml(host);
    assert.match(html, /data-callout="note"/);
    assert.match(html, /callout-title/);
    assert.doesNotMatch(html, /onclick|<script|<svg|<img|<iframe|<button|app:\/\/|javascript:|type="text"/);
    assert.match(html, /disabled/);
    failure = true;
    await assert.rejects(createShareRenderer(app, parent)('safe', 'Notes/demo.md'), /renderer failed/);
    assert.equal(active, 0);
    assert.equal(dom.window.document.body.children.length, 0);
  });
} finally { await server.stop(); await fs.rm(temp, { recursive: true, force: true }); dom.window.close(); }
console.log(`${passed} share-rendering checks passed`);
