import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-panel-recovery-'));
const stub = `
class Element {
  constructor(text = '') { this.text = text; this.children = []; this.attrs = {}; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  createEl(tag, options = {}) { const child = new Element(options.text || ''); child.tag = tag; child.cls = options.cls || ''; child.attrs = options.attr || {}; child.value = options.value || ''; this.children.push(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  empty() { this.text = ''; this.children = []; }
  addClass() {}
  removeClass() {}
  setText(text) { this.text = text; }
  setAttribute(name, value) { this.attrs[name] = value; }
  setCssProps(props) { this.css = props; }
  querySelector() { return null; }
}
export class ItemView { constructor(leaf) { this.app = leaf.app; this.contentEl = new Element(); } registerEvent() {} }
export class Modal { constructor(app) { this.app = app; this.contentEl = new Element(); this.modalEl = new Element(); } close() { this.onClose?.(); } }
export class Menu {}
export class Setting {}
export class Notice {}
export class App {}
export class TFile {}
export class WorkspaceLeaf {}
export function setIcon() {}
`;
try {
  await esbuild.build({
    stdin: { contents: 'export { AgentNoteView, DataRepairModal, InsightsModal } from "./src/ui/panel"; export { VaultStore } from "./src/core/store"; export { setLanguage } from "./src/i18n";', resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dir, 'ui.cjs'),
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    plugins: [{ name: 'test-host', setup(build) {
      build.onLoad({ filter: /[/\\]src[/\\]ui[/\\]panel\.ts$/ }, async args => ({ contents: (await fs.readFile(args.path, 'utf8')) + '\nexport { InsightsModal };', loader: 'ts' }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: stub, loader: 'js' }));
    } }],
  });
  const { AgentNoteView, DataRepairModal, InsightsModal, VaultStore, setLanguage } = createRequire(import.meta.url)(path.join(dir, 'ui.cjs'));
  globalThis.window = { setTimeout: () => 0, requestAnimationFrame: () => 0 };
  setLanguage('zh');
  const vault = path.join(dir, 'vault');
  const store = new VaultStore(vault, '.obsidian', { deviceIdFile: path.join(dir, 'device-id') });
  const realInsights = store.getDashboardInsights.bind(store);
  await store.init();
  const snapshot = await realInsights();
  const eventDay = new Date(); eventDay.setHours(12, 0, 0, 0);
  const priorDay = new Date(eventDay); priorDay.setDate(priorDay.getDate() - 1);
  const events = [
    { at: eventDay.toISOString(), type: 'node-updated', title: 'Launch plan', actor: { name: 'Codex', sessionTitle: 'Private task' }, origin: 'agent' },
    { at: eventDay.toISOString(), type: 'share-resolved', title: 'Research notes', actor: { name: 'Claude Code' }, origin: 'agent' },
    { at: priorDay.toISOString(), type: 'local-read', title: 'Launch plan', origin: 'local' },
  ];
  const profile = new InsightsModal({}, { store: { getDashboardInsights: async () => snapshot, getAgentInsights: async () => [{ name: 'Codex', uses: 1, created: 0, updated: 1, lastActive: eventDay.toISOString() }], listActivity: async () => events } });
  profile.tab = 'timeline';
  profile.timelineAgent = 'Codex';
  profile.timelineQuery = 'launch';
  await profile.render();
  assert.match(profile.contentEl.textContent, /更新「Launch plan」/);
  assert.doesNotMatch(profile.contentEl.textContent, /访问分享链接「Research notes」|本地阅读「Launch plan」/);
  profile.timelineAgent = '__local'; profile.timelineQuery = '';
  await profile.render();
  assert.match(profile.contentEl.textContent, /本地阅读「Launch plan」/);
  assert.doesNotMatch(profile.contentEl.textContent, /更新「Launch plan」/);
  profile.timelineAgent = ''; profile.timelineDay = profile.dayKey(eventDay);
  await profile.render();
  assert.doesNotMatch(profile.contentEl.textContent, /本地阅读「Launch plan」/);
  profile.privateView = true;
  await profile.render();
  assert.doesNotMatch(profile.contentEl.textContent, /Codex|Claude Code|Private task|Launch plan|Research notes/);
  profile.tab = 'overview'; profile.selectedDay = profile.dayKey(priorDay); profile.privateView = false;
  await profile.render();
  assert.match(profile.contentEl.textContent, /关联活动/);
  assert.match(profile.contentEl.textContent, /本地阅读「Launch plan」/);
  const elements = profile.contentEl.children.flatMap(function collect(element) { return [element, ...element.children.flatMap(collect)]; });
  assert.equal(elements.filter(element => element.attrs.role === 'tab').length, 5);
  assert.ok(!elements.some(element => element.attrs.role === 'tab' && element.text === '本周'));
  assert.ok(elements.some(element => element.tag === 'button' && element.cls.startsWith('agentnote-profile-day')));
  assert.ok(elements.some(element => element.tag === 'button' && element.text === '累计'));
  const contribution = { document: { id: 'd-launch', title: 'Launch plan', path: 'Launch plan.md' }, score: 3, construction: 3, reuse: 0, connection: 0, organization: 0 };
  snapshot.documents = [contribution];
  snapshot.weeklyDocuments = [contribution];
  for (const sourceTab of ['overview', 'month']) {
    profile.tab = sourceTab; profile.timelineAgent = 'Claude Code'; profile.timelineDay = '2000-01-01'; profile.timelineFilter = 'organization';
    await profile.render();
    if (sourceTab === 'overview') assert.match(profile.contentEl.textContent, /本周文档贡献/);
    const recordButton = profile.contentEl.children.flatMap(function collect(element) { return [element, ...element.children.flatMap(collect)]; }).find(element => element.tag === 'button' && element.text === '查看活动记录');
    recordButton.onclick();
    await profile.render();
    assert.equal(profile.tab, 'timeline');
    assert.equal(profile.timelineQuery, 'Launch plan');
    assert.equal(profile.timelineAgent, '');
    assert.equal(profile.timelineDay, null);
    assert.equal(profile.timelineFilter, 'all');
    assert.match(profile.contentEl.textContent, /更新「Launch plan」/);
    assert.match(profile.contentEl.textContent, /本地阅读「Launch plan」/);
    assert.doesNotMatch(profile.contentEl.textContent, /访问分享链接「Research notes」/);
  }
  console.log('PASS profile search, collaborator/date filters, privacy, inline day records and document-to-timeline navigation');
  const file = path.join(vault, 'agentNote/data/documents.json');
  const damaged = process.env.AGENTNOTE_DAMAGED_DOCUMENTS
    ? await fs.readFile(process.env.AGENTNOTE_DAMAGED_DOCUMENTS, 'utf8')
    : '<<<<<<< HEAD\n[]\n=======\n[]\n>>>>>>> origin/main\n';
  await fs.writeFile(file, damaged);
  let sharedPath;
  const plugin = { store, server: { port: 27182 }, settings: { port: 27182, showQuickStart: true }, connectedAgents: async () => [], shareFileFromPanel: async (filePath) => { sharedPath = filePath; return true; } };
  let activeFile = { basename: 'Current note', path: 'Current note.md' };
  let onFileOpen;
  const view = new AgentNoteView({ app: { workspace: { on: (_event, handler) => { onFileOpen = handler; return {}; }, getActiveFile: () => activeFile } } }, plugin);
  // The actual dashboard renderer involves animation; this test checks its loading boundary.
  view.renderDashboard = (_insights, parent) => parent.createEl('h4', { text: 'Loaded dashboard' });
  await view.onOpen();
  assert.match(view.contentEl.textContent, /看板暂时无法加载/);
  assert.match(view.contentEl.textContent, /documents.json/);
  assert.match(view.contentEl.textContent, /服务正在运行/);
  assert.match(view.contentEl.textContent, /Claude Code/);
  assert.match(view.contentEl.textContent, /Codex/);
  const shareButton = view.contentEl.children.flatMap(function collect(element) { return [element, ...element.children.flatMap(collect)]; }).find((element) => element.tag === 'button' && element.text === '分享当前笔记');
  await shareButton.onclick();
  assert.equal(sharedPath, 'Current note.md');
  assert.match(view.contentEl.textContent, /链接已复制/);
  activeFile = null;
  onFileOpen();
  assert.match(view.contentEl.textContent, /尚未打开笔记/);
  activeFile = { basename: 'Current note', path: 'Current note.md' };
  onFileOpen();
  assert.match(view.contentEl.textContent, /分享当前笔记/);
  assert.equal(await fs.readFile(file, 'utf8'), damaged);
  console.log('PASS corrupt documents show an error, preserve bytes, and keep service/Agent controls');
  await fs.writeFile(file, '[]');
  await view.refresh();
  assert.match(view.contentEl.textContent, /Loaded dashboard/);
  assert.doesNotMatch(view.contentEl.textContent, /看板暂时无法加载/);
  console.log('PASS repairing data and reloading restores dashboard');
  plugin.connectedAgents = async () => { throw new Error('connections.json damaged'); };
  await view.refresh();
  assert.match(view.contentEl.textContent, /Agent 接入记录暂时无法加载/);
  assert.match(view.contentEl.textContent, /Codex/);
  assert.match(view.contentEl.textContent, /接入状态暂时不可用/);
  assert.match(view.contentEl.textContent, /Loaded dashboard/);
  assert.match(view.contentEl.textContent, /服务正在运行/);
  console.log('PASS connection errors do not hide dashboard or service controls');
  let release;
  store.getDashboardInsights = () => new Promise(resolve => release = resolve);
  const pending = view.refresh();
  assert.match(view.contentEl.textContent, /正在加载看板/);
  assert.match(view.contentEl.textContent, /服务正在运行/);
  await view.onClose();
  release({}); await pending;
  assert.equal(view.contentEl.textContent, '');
  console.log('PASS loading shows service immediately; closed views ignore late results');
  store.getDashboardInsights = realInsights;
  plugin.connectedAgents = async () => [];
  await fs.writeFile(file, damaged);
  const modal = new DataRepairModal({}, plugin, () => view.refresh());
  await modal.check();
  assert.match(modal.contentEl.textContent, /可自动修复/);
  const find = (el, label) => el.tag === 'button' && el.text === label ? el : el.children.map(child => find(child, label)).find(Boolean);
  await find(modal.contentEl, '修复可恢复的数据').onclick();
  assert.match(view.contentEl.textContent, /Loaded dashboard/);
  assert.match(modal.contentEl.textContent, /已修复 1 个文件，保存 1 份备份/);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /^<<<<<<< /m);
  console.log('PASS repair modal click backs up data and restores the panel without a restart');
  const activities = Array.from({ length: 10 }, (_, index) => ({ type: 'share-created', title: `Note ${index}`, at: new Date(Date.now() - index * 60_000).toISOString() }));
  const insights = { summary: { weekActivityCount: 0, weekResolves: 0, weekActivityScore: 0, weekUpdated: 0 }, weeklyTrend: [], activities };
  view.contentEl.empty();
  delete view.renderDashboard;
  view.renderDashboard(insights, view.contentEl);
  const activityList = view.recentActivityList;
  const toggle = view.recentActivityToggle;
  assert.equal(activityList.children.length, 10);
  assert.equal(activityList.children.filter((item) => !item.hidden).length, 3);
  assert.match(toggle.text, /展开最近 10 条/);
  toggle.onclick();
  assert.equal(activityList.children.filter((item) => !item.hidden).length, 10);
  toggle.onclick();
  assert.equal(activityList.children.filter((item) => !item.hidden).length, 3);
  console.log('PASS recent activity expands ten historical items and collapses to three');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
