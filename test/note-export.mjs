import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
const require = createRequire(import.meta.url);
const { buildExportHtml, writeExportFile, copyExportFile, verifyExportFile, copyExportFileAndVerify } = require('./core-bundle.cjs');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-export-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
const source = { title: '旅行 <计划> & 好软件', sourcePath: 'Notes/旅行.md', content: '# 原文\n\n图片会一起导出。\n\n![[好 软件.png|320]]\n\n![图](assets/photo.png)\n\n```dataviewjs\napp.vault.delete(secret)\n```\n\n<script>alert(1)</script>' };
const reads = [];
const renderer = {
  async renderMarkdown(markdown, sourcePath) { assert.equal(sourcePath, source.sourcePath); assert.doesNotMatch(markdown, /dataviewjs|<script>/); return new MarkdownIt({ html: false }).render(markdown); },
  async readImage(link, sourcePath) { reads.push([link, sourcePath]); return { bytes: png, mime: 'image/png' }; },
};
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  let html;
  await test('portable HTML embeds image bytes and omits local share APIs, paths and metadata', async () => {
    html = await buildExportHtml(source, renderer);
    const doc = new JSDOM(html).window.document;
    assert.equal(doc.title, source.title);
    assert.equal(doc.querySelectorAll('img').length, 2);
    for (const image of doc.querySelectorAll('img')) {
      assert.equal(image.src, 'data:image/png;base64,' + png.toString('base64'));
      assert.equal(image.loading || image.getAttribute('loading'), 'eager');
    }
    assert.equal(doc.querySelector('img').getAttribute('width'), '320');
    assert.equal(doc.querySelectorAll('script').length, 0);
    assert.match(doc.querySelector('article').textContent, /app.vault.delete/);
    assert.doesNotMatch(html, /127\.0\.0\.1|localhost|app:\/\/|\/api\/shares|agentnote-context|Notes\/旅行/);
    assert.ok(reads.every(([, original]) => original === source.sourcePath));
  });
  await test('selection exports only its content and images without expanding another note', async () => {
    reads.length = 0;
    const selected = await buildExportHtml({ ...source, content: '只分享选段\n\n![[selected.png]]\n\n![[Other note]]', selection: true }, renderer);
    assert.deepEqual(reads.map(([link]) => link), ['selected.png']);
    assert.match(selected, /这是分享的选段/);
    assert.doesNotMatch(selected, /好 软件|app.vault.delete/);
    assert.match(selected, /!\[\[Other note\]\]/);
  });
  await test('missing, remote or oversized image content never produces a misleading successful export', async () => {
    await assert.rejects(buildExportHtml(source, { ...renderer, readImage: async () => null }), /图片无法导出/);
    await assert.rejects(buildExportHtml({ ...source, content: '![](https://example.invalid/image.png)' }, renderer), /网络图片/);
    await assert.rejects(buildExportHtml({ ...source, content: '![[one.png]]\n\n![[two.png]]' }, { ...renderer, readImage: async () => ({ bytes: Buffer.alloc(26 * 1024 * 1024), mime: 'image/png' }) }), /50 MiB/);
  });
  await test('generated HTML files persist for native paste and repeated exports never overwrite each other', async () => {
    const unexpectedPrint = async () => { throw new Error('HTML must not print'); };
    const first = await writeExportFile('../CON:<x>', 'html', html, unexpectedPrint, temp);
    const second = await writeExportFile('../CON:<x>', 'html', html, unexpectedPrint, temp);
    assert.notEqual(first, second);
    assert.ok(path.relative(temp, first) && !path.relative(temp, first).startsWith('..'));
    assert.equal(await fs.readFile(first, 'utf8'), html);
    assert.equal(await fs.readFile(second, 'utf8'), html);
  });
  await test('PDF uses the same complete HTML and cleans intermediate files on success and failure', async () => {
    const printed = [];
    const pdf = await writeExportFile(source.title, 'pdf', html, async file => { printed.push(file); assert.equal(await fs.readFile(file, 'utf8'), html); return Buffer.from('%PDF-1.7\ntest'); }, temp);
    assert.match(pdf, /\.pdf$/);
    assert.equal(await fs.readFile(pdf, 'utf8'), '%PDF-1.7\ntest');
    await assert.rejects(fs.stat(printed[0]), { code: 'ENOENT' });
    let failedFolder;
    await assert.rejects(writeExportFile('failure', 'pdf', html, async file => { failedFolder = path.dirname(file); throw new Error('print failure'); }, temp), /print failure/);
    await assert.rejects(fs.stat(failedFolder), { code: 'ENOENT' });
    await assert.rejects(writeExportFile('invalid', 'pdf', html, async () => Buffer.from('not a PDF'), temp), /PDF/);
  });
  await test('clipboard adapters copy native file references and never interpolate filenames into executable code', async () => {
    const file = path.join(temp, '中文 " $() ` [x].html');
    const commands = [];
    const record = async (...args) => { commands.push(args); };
    await copyExportFile(file, 'darwin', record);
    assert.equal(commands[0][0], '/usr/bin/osascript');
    assert.equal(commands[0][1].at(-1), file);
    assert.doesNotMatch(commands[0][1][3], /中文/);
    await copyExportFile(file, 'win32', record);
    assert.equal(commands[1][2].env.AGENTNOTE_EXPORT_FILE, file);
    assert.match(commands[1][1].at(-1), /Set-Clipboard -LiteralPath \$env:AGENTNOTE_EXPORT_FILE/);
    await copyExportFile(file, 'linux', record);
    assert.match(commands[2][2].input, /^file:\/\//);
    assert.doesNotMatch(commands[2][2].input, /中文| /);
    const fallback = [];
    await copyExportFile(file, 'linux', async (...args) => { fallback.push(args); if (args[0] === 'wl-copy') throw new Error('not installed'); });
    assert.equal(fallback[1][0], 'xclip');
    await assert.rejects(copyExportFile(file, 'darwin', async () => { throw new Error('clipboard denied'); }), /clipboard denied/);
  });
  await test('clipboard verification is independent and a successful command cannot fake a successful copy', async () => {
    const file = path.join(temp, '中文 #1.html');
    const phases = [];
    const written = async () => { phases.push('write'); return 'darwin'; };
    const missing = async (path, target) => { assert.equal(path, file); assert.equal(target, 'darwin'); phases.push('verify'); return false; };
    assert.equal(await copyExportFileAndVerify(file, written, missing), false);
    assert.deepEqual(phases, ['write', 'verify']);
    assert.equal(await copyExportFileAndVerify(file, written, async () => true), true);
    assert.equal(await copyExportFileAndVerify(file, async () => { throw new Error('write denied'); }, async () => { throw new Error('must not verify'); }), false);
    assert.equal(await copyExportFileAndVerify(file, written, async () => { throw new Error('verification denied'); }), false);
    assert.equal(await verifyExportFile(file, 'wayland', async command => { assert.equal(command, 'wl-paste'); return pathToFileURL(file).href + '\r\n'; }), true);
    assert.equal(await verifyExportFile(file, 'x11', async command => { assert.equal(command, 'xclip'); return '# file list\n' + pathToFileURL(file).href + '\n'; }), true);
    assert.equal(await verifyExportFile(file, 'wayland', async () => 'file:///some/other.html'), false);
    assert.equal(await verifyExportFile(file, 'wayland', async () => ''), false);
    assert.equal(await verifyExportFile(file, 'x11', async () => 'plain path text'), false);
    assert.equal(await verifyExportFile(file, 'wayland', async command => { assert.equal(command, 'wl-paste'); throw new Error('read unavailable'); }), false);
  });
  if (process.platform === 'darwin') await test('real macOS file clipboard round-trip uses an isolated pasteboard and rejects absent or different files', async () => {
    const exec = promisify(execFile);
    const board = 'org.agentnote.test.' + randomUUID();
    const file = path.join(temp, '真实 中文 空格 \" #1.html');
    await fs.writeFile(file, '<!doctype html><p>native clipboard test</p>');
    const nativeRunner = async (command, args) => (await exec(command, [...args, board], { timeout: 15000 })).stdout;
    try {
      assert.equal(await verifyExportFile(file, 'darwin', nativeRunner), false);
      const target = await copyExportFile(file, 'darwin', nativeRunner);
      assert.equal(await verifyExportFile(file, target, nativeRunner), true);
      const legacy = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit');function run(argv){var files=ObjC.deepUnwrap($.NSPasteboard.pasteboardWithName(argv[0]).propertyListForType('NSFilenamesPboardType'));if(!Array.isArray(files)||files.length!==1)throw new Error('Missing native file list');}", board]);
      assert.equal(legacy.stderr, '');
      assert.equal(await verifyExportFile(path.join(temp, 'wrong.html'), target, nativeRunner), false);
    } finally {
      await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit');function run(argv){$.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally;}", board]);
    }
  });
  await test('Electron PDF window is hidden and sandboxed, and destroyed after printing or failure', async () => {
    let destroyed = 0;
    let fail = false;
    class BrowserWindow {
      constructor(options) {
        assert.equal(options.show, false);
        assert.equal(options.webPreferences.nodeIntegration, false);
        assert.equal(options.webPreferences.javascript, false);
        this.webContents = {
          setWindowOpenHandler(handler) { assert.equal(handler().action, 'deny'); },
          on() {},
          async printToPDF(options) { assert.equal(options.pageSize, 'A4'); return Buffer.from('%PDF-1.7'); },
        };
      }
      async loadFile(file) { assert.equal(file, '/safe/export.html'); if (fail) throw new Error('load failed'); }
      destroy() { destroyed++; }
    }
    const bundle = await build({ entryPoints: ['src/exportFiles.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron', '@electron/remote'], write: false, logLevel: 'silent' });
    const exported = { exports: {} };
    vm.runInNewContext(bundle.outputFiles[0].text, { module: exported, exports: exported.exports, require: name => name === 'electron' ? {} : name === '@electron/remote' ? { BrowserWindow } : name === 'obsidian' ? {} : require(name), process, Buffer, setTimeout, clearTimeout });
    await exported.exports.printExportPdf('/safe/export.html');
    assert.equal(destroyed, 1);
    fail = true;
    await assert.rejects(exported.exports.printExportPdf('/safe/export.html'), /load failed/);
    assert.equal(destroyed, 2);
  });
} finally { await fs.rm(temp, { recursive: true, force: true }); }
console.log(`${passed} note-export checks passed`);
