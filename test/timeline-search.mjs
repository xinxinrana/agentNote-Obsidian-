import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { document, HTMLElement, InputEvent, CompositionEvent } = dom.window;
const proto = HTMLElement.prototype;
proto.createEl = function(tag, options = {}) {
  const el = document.createElement(tag);
  el.className = options.cls || '';
  if (options.text) el.textContent = options.text;
  if (options.value !== undefined) el.value = options.value;
  for (const [name, value] of Object.entries(options.attr || {})) el.setAttribute(name, value);
  this.append(el); return el;
};
proto.createDiv = function(options) { return this.createEl('div', options); };
proto.createSpan = function(options) { return this.createEl('span', options); };
proto.empty = function() { this.replaceChildren(); };
proto.addClass = function(name) { this.classList.add(name); };
proto.removeClass = function(name) { this.classList.remove(name); };
proto.setText = function(text) { this.textContent = text; };
class Modal {
  constructor(app) { this.app = app; this.modalEl = document.body.createDiv(); this.contentEl = this.modalEl.createDiv(); }
  close() { this.onClose?.(); this.modalEl.remove(); }
}
const host = { Modal, ItemView: class {}, Notice: class {}, TFile: class {}, setIcon() {} };
const built = await build({
  entryPoints: ['src/ui/panel.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'], write: false,
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ico': 'dataurl' }, logLevel: 'silent',
  plugins: [{ name: 'test-exports', setup(build) { build.onLoad({ filter: /[/\\]src[/\\]ui[/\\]panel\.ts$/ }, async args => ({ contents: await fs.readFile(args.path, 'utf8') + '\nexport { InsightsModal };', loader: 'ts' })); } }],
});
const timers = new Map(); let timerId = 0;
const window = { setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } };
const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); };
const exported = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, { module: exported, exports: exported.exports, require: name => name === 'obsidian' ? host : require(name), window, Buffer, process });
const reads = { insights: 0, agents: 0, activity: 0 };
const at = new Date().toISOString();
const events = Array.from({ length: 4500 }, (_, i) => ({ at, type: 'local-edited', title: '资料 Record ' + i, origin: 'local' }));
events.unshift({ at, type: 'local-edited', title: '中文笔记', actor: { name: 'Codex' } }, { at, type: 'local-read', title: '中文笔记', actor: { name: 'Claude' } }, { at, type: 'document-linked', title: 'Other', actor: { name: 'Codex' } });
const modal = new exported.exports.InsightsModal({}, {
  store: { async getDashboardInsights() { reads.insights++; return { health: { complete: true }, summary: { weekResolves: 1 } }; }, async getAgentInsights() { reads.agents++; return []; }, async listActivity() { reads.activity++; return events; } },
  async connectedAgents() { return []; },
}, 'timeline');
try {
  await modal.render();
  const query = modal.contentEl.querySelector('input');
  const body = modal.contentEl.querySelector('.agentnote-modal-body');
  const header = modal.contentEl.querySelector('.agentnote-modal-header');
  const results = modal.contentEl.querySelector('.agentnote-timeline-results');
  const count = modal.contentEl.querySelector('[role="status"]');
  const titles = () => [...results.querySelectorAll('.agentnote-timeline-title')].map(el => el.textContent);
  const input = (value, composing = false) => { query.value = value; query.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing })); };
  query.focus();
  body.scrollTop = 90;
  assert.equal(titles().length, 100);
  results.querySelector('button')?.click(); // Current events have no open-file buttons, so this is load-more.
  assert.equal(titles().length, 200);
  input('中文'); query.setSelectionRange(2, 2);
  flush();
  assert.equal(titles().length, 2);
  assert.equal(count.textContent, '2 条记录');
  assert.equal(modal.contentEl.querySelector('input'), query);
  assert.equal(modal.contentEl.querySelector('.agentnote-modal-header'), header);
  assert.equal(document.activeElement, query);
  assert.equal(query.selectionStart, 2);
  assert.equal(body.scrollTop, 90);
  query.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  input('zhongwen', true); flush();
  assert.equal(titles().length, 2);
  assert.equal(modal.timelineQuery, '中文');
  assert.equal(document.activeElement, query);
  query.value = '中文笔记';
  query.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文笔记' }));
  query.dispatchEvent(new InputEvent('input', { bubbles: true }));
  assert.equal(timers.size, 1);
  flush();
  assert.equal(modal.timelineQuery, '中文笔记');
  assert.equal(titles().length, 2);
  input('O'); input('Ot'); input('Other');
  assert.equal(timers.size, 1); flush();
  assert.equal(titles().length, 1);
  assert.match(titles()[0], /Other/);
  input(''); flush();
  assert.equal(titles().length, 100);
  const collaborator = modal.contentEl.querySelector('select');
  collaborator.value = 'Codex'; collaborator.dispatchEvent(new dom.window.Event('change'));
  assert.equal(titles().length, 2);
  input('中文'); flush();
  assert.equal(titles().length, 1);
  const reuse = [...modal.contentEl.querySelectorAll('.agentnote-timeline-filters button')].find(el => el.textContent === '使用');
  reuse.click();
  assert.equal(titles().length, 0);
  assert.equal(count.textContent, '0 条记录');
  assert.ok(reuse.classList.contains('is-active'));
  collaborator.value = ''; collaborator.dispatchEvent(new dom.window.Event('change'));
  assert.equal(titles().length, 1);
  assert.equal(modal.contentEl.querySelector('input'), query);
  assert.equal(modal.contentEl.querySelector('.agentnote-modal-body'), body);
  assert.deepEqual(reads, { insights: 1, agents: 1, activity: 1 });
  input('pending'); assert.equal(timers.size, 1);
  modal.close(); assert.equal(timers.size, 0); flush();
  assert.equal(modal.modalEl.isConnected, false);
  console.log('PASS #14: 4503 events; stable input/focus/caret/scroll, IME commit, debouncing, filtering, pagination, zero extra data reads, close cleanup');
} finally { dom.window.close(); }
