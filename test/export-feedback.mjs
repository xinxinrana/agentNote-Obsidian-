import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const notices = [];
const warnings = [];
class HostClass {}
const obsidian = { Plugin: HostClass, Modal: HostClass, PluginSettingTab: HostClass, ItemView: HostClass, Notice: class { constructor(message) { notices.push(message); } } };
const file = '/private/tmp/agentnote-test/中文文件.html';
let revealFailure = false;
let moduleFailure = false;
const revealed = [];
const electron = { shell: { showItemInFolder(path) { if (revealFailure) throw new Error('reveal failed'); revealed.push(path); } } };
const pluginBundle = await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron', '@electron/remote'], write: false,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.ico': 'dataurl' }, logLevel: 'silent',
  plugins: [{ name: 'export-result', setup(build) {
    build.onResolve({ filter: /^\.\/exportFiles$/ }, () => ({ path: 'exportFiles', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function exportNoteFile() { return globalThis.exportResult; }', loader: 'js' }));
  } }],
});
const exported = { exports: {} };
const context = {
  module: exported, exports: exported.exports, Buffer, process, setTimeout, clearTimeout,
  require: name => name === 'obsidian' ? obsidian : name === 'electron' ? (() => { if (moduleFailure) throw new Error('module unavailable'); return electron; })() : require(name),
  exportResult: { file, copied: false },
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

const nativeBundle = await build({ entryPoints: ['src/exportFiles.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron', '@electron/remote'], write: false, logLevel: 'silent' });
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
