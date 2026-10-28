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
export class Setting {
  constructor(parent) { this.element = parent.createDiv(); }
  setName() { return this; }
  setDesc() { return this; }
  addDropdown(callback) { const control = { addOptions: () => control, setValue: () => control, onChange: () => control }; callback(control); return this; }
  addText(callback) { const control = { setPlaceholder: () => control, onChange: () => control }; callback(control); return this; }
  addTextArea(callback) { const control = { inputEl: { addClass() {} }, setPlaceholder: () => control, onChange: () => control }; callback(control); return this; }
  addButton(callback) { const element = this.element.createEl('button'); const control = { setButtonText: text => { element.setText(text); return control; }, setCta: () => control, onClick: handler => { element.onclick = handler; return control; } }; callback(control); return this; }
}
export class Notice {}
export class App {}
export class TFile {}
export class WorkspaceLeaf {}
export function setIcon() {}
`;
try {
  await esbuild.build({
    stdin: { contents: 'export { AgentNoteView, DataRepairModal, FeedbackModal, InsightsModal } from "./src/ui/panel"; export { VaultStore } from "./src/core/store"; export { setLanguage } from "./src/i18n";', resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dir, 'ui.cjs'),
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ico': 'dataurl' },
    plugins: [{ name: 'test-host', setup(build) {
      build.onLoad({ filter: /[/\\]src[/\\]ui[/\\]panel\.ts$/ }, async args => ({ contents: (await fs.readFile(args.path, 'utf8')) + '\nexport { InsightsModal };', loader: 'ts' }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: stub, loader: 'js' }));
    } }],
  });
  const { AgentNoteView, DataRepairModal, FeedbackModal, InsightsModal, VaultStore, setLanguage } = createRequire(import.meta.url)(path.join(dir, 'ui.cjs'));
  globalThis.window = { setTimeout: () => 0, requestAnimationFrame: () => 0 };
  setLanguage('zh');
  const vault = path.join(dir, 'vault');
  const store = new VaultStore(vault, '.obsidian', { deviceIdFile: path.join(dir, 'device-id'), referencesFile: path.join(dir, 'references.json') });
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
  profile.tab = 'month';
  await profile.render();
  const graphCells = profile.contentEl.children.flatMap(function collect(element) { return [element, ...element.children.flatMap(collect)]; }).filter(element => element.cls?.includes('agentnote-contribution-cell') && element.tag === 'button');
  assert.ok(graphCells.length > 0);
  assert.ok(graphCells.every(element => element.attrs['aria-label'] && !element.attrs.title));
  console.log('PASS contribution cells expose one accessible tooltip without a native title');
  const contribution = { document: { id: 'd-launch', title: 'Launch plan', path: 'Launch plan.md' }, activityCount: 3, recentActivityCount: 3, score: 3, construction: 3, reuse: 0, connection: 0, organization: 0 };
  snapshot.documents = [contribution];
  snapshot.weeklyDocuments = [contribution];
  for (const sourceTab of ['overview', 'month']) {
    profile.tab = sourceTab; profile.timelineAgent = 'Claude Code'; profile.timelineDay = '2000-01-01'; profile.timelineFilter = 'organization';
    await profile.render();
    assert.match(profile.contentEl.textContent, /3 次活动/);
    assert.match(profile.contentEl.textContent, /内容建设 3 次/);
    assert.doesNotMatch(profile.contentEl.textContent, /活动值|活跃分/);
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
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => copied.push(value) } } });
  const feedback = new FeedbackModal({}, { manifest: { version: '0.5.3' } });
  feedback.onOpen();
  feedback.title = 'Feedback link test';
  const opened = [];
  window.open = (url, target) => { opened.push({ url, target }); return null; };
  const feedbackButton = (modal, label) => modal.contentEl.children.flatMap(function collect(element) { return [element, ...element.children.flatMap(collect)]; }).find(element => element.tag === 'button' && element.text === label);
  feedbackButton(feedback, '前往 GitHub').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened[0].target, '_external');
  assert.match(opened[0].url, /github\.com\/xinxinrana\/agentNote-Obsidian-\/issues\/new\?/);
  assert.match(copied[0], /Feedback link test/);
  assert.ok(!feedback.contentEl.children.some(element => element.cls === 'agentnote-feedback-fallback'));
  window.open = () => { throw new Error('blocked'); };
  const blockedFeedback = new FeedbackModal({}, { manifest: { version: '0.5.3' } });
  blockedFeedback.onOpen();
  blockedFeedback.title = 'Blocked feedback';
  feedbackButton(blockedFeedback, '前往反馈站').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blockedFeedback.contentEl.children.at(-1).children[1].value, 'https://agentnote-feedback.pocketbay.app/');
  console.log('PASS feedback uses the external browser and leaves a manual URL when opening fails');
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
  assert.match(view.contentEl.textContent, /Loaded dashboard/);
  assert.equal((await store.getDashboardInsights()).health.documentsAvailable, false);
  assert.match(view.contentEl.textContent, /服务正在运行/);
  assert.match(view.contentEl.textContent, /Claude Code/);
  assert.match(view.contentEl.textContent, /Codex/);
  plugin.server = null;
  plugin.serverPortInUse = true;
  await view.refresh();
  assert.match(view.contentEl.textContent, /端口已被占用/);
  assert.match(view.contentEl.textContent, /另一个仓库/);
  assert.match(view.contentEl.textContent, /重试启动/);
  plugin.server = { port: 27182 };
  plugin.serverPortInUse = false;
  await view.refresh();
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
  console.log('PASS corrupt documents preserve the dashboard, service, Agent controls, and source bytes');
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
  const insights = { health: { complete: true, issues: [], documentsAvailable: true }, summary: { weekActivityCount: 0, weekResolves: 0, weekActivityScore: 0, weekUpdated: 0 }, weeklyTrend: [], activities };
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
  const agentIcon = 'data:image/svg+xml;base64,PHN2Zy8+';
  const isAvatar = (element) => element.tag === 'img' && element.cls.includes('agentnote-agent-avatar');
  const collectAll = (element) => [element, ...element.children.flatMap(collectAll)];
  const connected = [{ name: 'Claude Code', skillPath: path.join(vault, 'SKILL.md'), connectedAt: new Date().toISOString(), icon: agentIcon }];
  view.agentConnections = connected;
  view.contentEl.empty();
  view.renderDashboard({ ...insights, activities: [{ type: 'share-resolved', title: 'Research notes', at: new Date().toISOString(), actor: { name: 'Claude Code' }, origin: 'agent' }] }, view.contentEl);
  const panelAvatars = collectAll(view.recentActivityList).filter(isAvatar);
  assert.equal(panelAvatars.length, 1);
  assert.equal(panelAvatars[0].attrs.src, agentIcon);
  assert.equal(panelAvatars[0].attrs.alt, 'Claude Code 图标');
  view.contentEl.empty();
  view.renderDashboard({ ...insights, activities: [{ type: 'share-resolved', title: 'Research notes', at: new Date().toISOString(), actor: { name: 'Unknown Bot' }, origin: 'agent' }] }, view.contentEl);
  assert.equal(collectAll(view.recentActivityList).filter(isAvatar).length, 0);
  console.log('PASS dashboard reuses connected agent icons and falls back for unknown agents');
  const iconPlugin = { store: { getDashboardInsights: async () => snapshot, getAgentInsights: async () => [{ name: 'Claude Code', uses: 1, created: 0, updated: 0, lastActive: eventDay.toISOString() }], listActivity: async () => events }, connectedAgents: async () => connected };
  const withIcons = new InsightsModal({}, iconPlugin);
  withIcons.tab = 'timeline';
  await withIcons.render();
  const timelineAvatars = collectAll(withIcons.contentEl).filter(isAvatar);
  // Codex comes from the bundled preset icons, Claude Code from the icon reported at connection time.
  assert.equal(timelineAvatars.length, 2);
  assert.ok(timelineAvatars.some((element) => element.attrs.src === agentIcon));
  withIcons.tab = 'agents';
  await withIcons.render();
  assert.equal(collectAll(withIcons.contentEl).filter(isAvatar).length, 1);
  withIcons.privateView = true;
  await withIcons.render();
  assert.equal(collectAll(withIcons.contentEl).filter(isAvatar).length, 0);
  console.log('PASS profile timeline and agent cards reuse connected icons without leaking them in privacy view');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
