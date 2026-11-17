import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const notices = [];
const warnings = [];
const dom = new JSDOM('<!doctype html><body></body>');
const document = dom.window.document;
const proto = dom.window.HTMLElement.prototype;
proto.createEl = function(tag, options = {}) { const el = document.createElement(tag); el.className = options.cls || ''; el.textContent = options.text || ''; this.append(el); return el; };
proto.createDiv = function(options) { return this.createEl('div', options); };
proto.empty = function() { this.replaceChildren(); };
let currentModal;
class Modal {
  constructor(app) { this.app = app; this.contentEl = document.body.createDiv(); }
  open() { currentModal = this; this.onOpen(); }
  close() { this.onClose?.(); this.contentEl.remove(); }
}
class Setting {
  constructor(parent) { this.el = parent; }
  setName() { return this; }
  addToggle(callback) { const input = this.el.createEl('input'); input.type = 'checkbox'; const toggle = { onChange(fn) { input.onchange = () => fn(input.checked); return toggle; } }; callback(toggle); return this; }
}
class HostClass {}
const obsidian = { Plugin: HostClass, Modal, Setting, PluginSettingTab: HostClass, ItemView: HostClass, Notice: class { constructor(message) { notices.push(message); } } };
const file = '/private/tmp/agentnote-test/中文文件.html';
let revealFailure = false;
let moduleFailure = false;
const revealed = [];
const electron = { shell: { showItemInFolder(path) { if (revealFailure) throw new Error('reveal failed'); revealed.push(path); } } };
const pluginBundle = await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron', '@electron/remote'], write: false,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.ico': 'dataurl', '.css': 'text' }, logLevel: 'silent',
  plugins: [{ name: 'export-result', setup(build) {
    build.onResolve({ filter: /^\.\/exportFiles$/ }, () => ({ path: 'exportFiles', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function exportNoteFile() { globalThis.exportCalls++; return globalThis.exportResult; } export async function openNativePdfExport() { globalThis.nativeCalls++; }', loader: 'js' }));
  } }],
});
const exported = { exports: {} };
const context = {
  module: exported, exports: exported.exports, Buffer, process, setTimeout, clearTimeout,
  require: name => name === 'obsidian' ? obsidian : name === 'electron' ? (() => { if (moduleFailure) throw new Error('module unavailable'); return electron; })() : require(name),
  exportCalls: 0, exportResult: { file, copied: false },
  console: { warn: (...args) => warnings.push(args) },
};
// No dynamic-import callback: like Obsidian's CommonJS plugin loader, native APIs use require.
vm.runInNewContext(pluginBundle.outputFiles[0].text, context);
const plugin = Object.create(exported.exports.default.prototype);
plugin.app = {};
plugin.store = { root: '/vault' };
assert.equal(await plugin.exportFileFromPanel('note.md', 'html'), false);
assert.deepEqual(revealed, [file]);
assert.equal(notices.length, 1);
assert.match(notices[0], /未确认复制成功/);
assert.doesNotMatch(notices[0], /导出失败|resolve module/);
revealFailure = true;
notices.length = 0;
assert.equal(await plugin.exportFileFromPanel('note.md', 'html'), false);
assert.equal(notices.length, 1);
assert.match(notices[0], /文件保留在/);
assert.ok(notices[0].includes(file));
assert.doesNotMatch(notices[0], /导出失败/);
moduleFailure = true;
notices.length = 0;
assert.equal(await plugin.exportFileFromPanel('note.md', 'html'), false);
assert.equal(notices.length, 1);
assert.ok(notices[0].includes(file));
context.exportResult = { file, copied: true };
notices.length = 0;
assert.equal(await plugin.exportFileFromPanel('note.md', 'html'), true);
assert.match(notices[0], /HTML 文件已复制/);
assert.equal(notices.length, 1);
console.log('PASS CommonJS host: copy failure reveals file; reveal/module failures preserve path without a second export error');

plugin.settings = { markdownExportNoticeDismissed: false };
plugin.store.setExcludedFolders = () => {};
plugin.refreshPanels = () => {};
let saved;
plugin.saveData = async data => { saved = structuredClone(data); };
const callsBeforeCancel = context.exportCalls;
const cancelled = plugin.exportFileFromPanel('note.md', 'md');
currentModal.contentEl.querySelector('input').click();
[...currentModal.contentEl.querySelectorAll('button')].find(el => el.textContent === '取消').click();
assert.equal(await cancelled, false);
assert.equal(context.exportCalls, callsBeforeCancel);
assert.equal(saved, undefined);
const dismissed = plugin.exportFileFromPanel('note.md', 'md');
currentModal.close();
assert.equal(await dismissed, false);
assert.equal(context.exportCalls, callsBeforeCancel);
const accepted = plugin.exportFileFromPanel('note.md', 'md');
[...currentModal.contentEl.querySelectorAll('button')].find(el => el.textContent === '我已知晓').click();
assert.equal(await accepted, true);
assert.equal(saved, undefined);
const remembered = plugin.exportFileFromPanel('note.md', 'md');
currentModal.contentEl.querySelector('input').click();
[...currentModal.contentEl.querySelectorAll('button')].find(el => el.textContent === '我已知晓').click();
assert.equal(await remembered, true);
assert.equal(saved.markdownExportNoticeDismissed, true);
plugin.loadData = async () => saved;
await plugin.loadSettings();
assert.equal(plugin.settings.markdownExportNoticeDismissed, true);
currentModal = null;
assert.equal(await plugin.exportFileFromPanel('note.md', 'md'), true);
assert.equal(currentModal, null);
plugin.loadData = async () => ({});
await plugin.loadSettings();
assert.equal(plugin.settings.markdownExportNoticeDismissed, false);
const beforeFailedSave = context.exportCalls;
plugin.saveData = async () => { throw new Error('settings write failed'); };
const failedSave = plugin.exportFileFromPanel('note.md', 'md');
currentModal.contentEl.querySelector('input').click();
[...currentModal.contentEl.querySelectorAll('button')].find(el => el.textContent === '我已知晓').click();
assert.equal(await failedSave, false);
assert.equal(plugin.settings.markdownExportNoticeDismissed, false);
assert.equal(context.exportCalls, beforeFailedSave);
console.log('PASS Markdown notice: cancel/dismiss, acknowledge, remember, reload and settings-save failure');
dom.window.close();

const nativeBundle = await build({ entryPoints: ['src/exportFiles.ts'], loader: { '.svg': 'dataurl', '.png': 'dataurl' }, bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron', '@electron/remote'], write: false, logLevel: 'silent' });
const nativeExport = { exports: {} };
let bytes = Buffer.alloc(0);
let writeFailure = false;
let mismatch = false;
const clipboard = {
  writeBuffer(format, value) { assert.equal(format, 'public.file-url'); if (writeFailure) throw new Error('permission denied'); bytes = Buffer.from(value); },
  readBuffer(format) { assert.equal(format, 'public.file-url'); return mismatch ? Buffer.alloc(0) : bytes; },
};
vm.runInNewContext(nativeBundle.outputFiles[0].text, {
  module: nativeExport, exports: nativeExport.exports,
  require: name => name === 'obsidian' ? obsidian : name === 'electron' ? { clipboard } : name === '@electron/remote' ? (() => { throw new Error('must use native clipboard'); })() : require(name),
  process: { platform: 'darwin' }, Buffer, console: { warn: (...args) => warnings.push(args) },
});
assert.equal(await nativeExport.exports.copyExportedFile(file), true);
mismatch = true;
assert.equal(await nativeExport.exports.copyExportedFile(file), false);
mismatch = false;
writeFailure = true;
assert.equal(await nativeExport.exports.copyExportedFile(file), false);
assert.ok(warnings.length >= 3);
assert.doesNotMatch(await fs.readFile('main.js', 'utf8'), /\bimport\(\s*["']electron["']\s*\)/);
console.log('PASS host clipboard: direct Electron write/read, mismatch and denied-write feedback; no bare electron dynamic import remains');

writeFailure = false;
mismatch = false;
const markdownApp = { vault: {
  getFileByPath(path) { return path === 'note.md' ? { extension: 'md', basename: '原始笔记' } : null; },
  async cachedRead() { return '# 原文\r\n\r\n![[missing-image.png|320]]\r\n'; },
} };
for (const selection of [undefined, '选段\n![[missing-image.png]]']) {
  const result = await nativeExport.exports.exportNoteFile(markdownApp, {}, '/vault', 'note.md', 'md', selection);
  assert.equal(result.file.endsWith('.md'), true);
  assert.equal(result.copied, true);
  assert.equal(await fs.readFile(result.file, 'utf8'), selection ?? await markdownApp.vault.cachedRead());
  await fs.rm((await import('node:path')).default.dirname(result.file), { recursive: true, force: true });
}
console.log('PASS Markdown export uses original note or selection without rendering or reading image files');

const events = [];
const target = { path: 'target.md', extension: 'md' };
const existing = { view: { file: target }, async openFile(file) { assert.equal(file, target); events.push('open'); } };
let dispatched = true;
const app = { vault: { getFileByPath(path) { return path === target.path ? target : null; } }, workspace: {
  getLeavesOfType(type) { assert.equal(type, 'markdown'); return [existing]; },
  getLeaf() { throw new Error('Must reuse the target note'); },
  setActiveLeaf(leaf, options) { assert.equal(leaf, existing); assert.equal(options.focus, true); events.push('focus'); },
}, commands: { executeCommandById(id) { assert.equal(id, 'workspace:export-pdf'); events.push('dispatch'); return dispatched; } } };
await nativeExport.exports.openNativePdfExport(app, target.path);
assert.deepEqual(events, ['open', 'focus', 'dispatch']);
dispatched = false;
await assert.rejects(nativeExport.exports.openNativePdfExport(app, target.path), /官方导出/);
await assert.rejects(nativeExport.exports.openNativePdfExport(app, 'missing.md'), /Markdown/);
await assert.rejects(nativeExport.exports.openNativePdfExport({ ...app, commands: undefined }, target.path), /官方导出/);
context.nativeCalls = 0;
notices.length = 0;
const exportCalls = context.exportCalls;
assert.equal(await plugin.exportFileFromPanel(target.path, 'native-pdf'), true);
assert.equal(context.nativeCalls, 1);
assert.equal(context.exportCalls, exportCalls);
assert.equal(notices.length, 0);
assert.equal(await plugin.exportFileFromPanel(target.path, 'native-pdf', 'selection'), false);
assert.equal(context.nativeCalls, 1);
assert.match(notices.at(-1), /整篇笔记/);
console.log('PASS native PDF opens the requested note before command dispatch, reports unavailable commands and never claims clipboard success or exports selections');
