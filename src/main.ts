import * as os from "os";
import { App, Editor, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { AgentServer } from "./core/server";
import { detectAgents, DetectedAgent, installSkill, uninstallSkill } from "./core/skill";
import { VaultStore } from "./core/store";
import { isNodeFile } from "./core/nodeFile";
import { AGENTNOTE_VIEW, AgentNoteView } from "./ui/panel";

export interface AgentProfile { enabled: boolean; instructions: string }
interface AgentNoteSettings { port: number; autostartServer: boolean; agents: Record<string, AgentProfile> }
const DEFAULT_SETTINGS: AgentNoteSettings = { port: 27182, autostartServer: true, agents: {} };

export default class AgentNotePlugin extends Plugin {
  settings: AgentNoteSettings = DEFAULT_SETTINGS;
  store!: VaultStore;
  server: AgentServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice("agentNote 需要桌面端文件系统 vault。"); return; }
    this.store = new VaultStore(adapter.getBasePath());
    await this.store.init();
    this.addSettingTab(new AgentNoteSettingTab(this.app, this));
    this.registerView(AGENTNOTE_VIEW, (leaf) => new AgentNoteView(leaf, this));
    this.addRibbonIcon("bot", "打开 agentNote 接入台", () => void this.activatePanel());
    this.addCommand({ id: "open-agentnote-panel", name: "打开 agentNote 接入台", callback: () => this.activatePanel() });
    this.addCommand({ id: "create-note", name: "新建 agentNote 笔记", callback: () => this.openCreateNoteModal() });
    this.addCommand({ id: "share-selection", name: "分享选中内容", editorCallback: (editor) => void this.shareSelection(editor) });
    this.addCommand({ id: "share-current-note", name: "分享当前文件", callback: () => void this.shareCurrentFile() });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!editor.getSelection()) return;
      menu.addItem((item) => item.setTitle("agentNote: 分享选中内容").setIcon("link").onClick(() => void this.shareSelection(editor)));
    }));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      menu.addItem((item) => item.setTitle("agentNote: 分享给 agent").setIcon("link").onClick(() => void this.sharePath(file.path)));
    }));
    if (this.settings.autostartServer) await this.startServer(true);
  }
  async onunload(): Promise<void> { this.app.workspace.detachLeavesOfType(AGENTNOTE_VIEW); await this.stopServer(true); }
  async activatePanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: AGENTNOTE_VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  refreshPanels(): void { for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) if (leaf.view instanceof AgentNoteView) void leaf.view.refresh(); }
  detectedAgents(): DetectedAgent[] { return detectAgents(os.homedir()); }
  profile(agentId: string): AgentProfile { return this.settings.agents[agentId] ?? { enabled: true, instructions: "" }; }
  async saveProfile(agentId: string, profile: AgentProfile): Promise<void> { this.settings.agents[agentId] = profile; await this.saveSettings(); }
  async installAgent(agent: DetectedAgent): Promise<void> {
    const profile = this.profile(agent.id);
    try {
      installSkill(agent.skillDir, { port: this.server?.port ?? this.settings.port, instructions: profile.instructions });
      await this.saveProfile(agent.id, { ...profile, enabled: true });
      new Notice(`${agent.name} 已接入 agentNote；重启 agent 后生效。`);
    } catch (error) {
      new Notice(`${agent.name} 接入失败：${(error as Error).message}`);
    }
    this.refreshPanels();
  }
  async disableAgent(agent: DetectedAgent): Promise<void> {
    try {
      uninstallSkill(agent.skillDir);
      await this.saveProfile(agent.id, { ...this.profile(agent.id), enabled: false });
      new Notice(`${agent.name} 的 agentNote 接入已移除。`);
    } catch (error) {
      new Notice(`${agent.name} 移除失败：${(error as Error).message}`);
    }
    this.refreshPanels();
  }
  async startServer(quiet = false): Promise<void> {
    if (this.server) return;
    this.server = new AgentServer(this.store, { port: this.settings.port });
    try { await this.server.start(); if (!quiet) new Notice(`agentNote 服务已启动：127.0.0.1:${this.server.port}`); }
    catch (error) { this.server = null; new Notice(`agentNote 服务启动失败：${(error as Error).message}`); }
    this.refreshPanels();
  }
  async stopServer(quiet = false): Promise<void> { if (!this.server) return; await this.server.stop(); this.server = null; if (!quiet) new Notice("agentNote 服务已停止。"); this.refreshPanels(); }

  openCreateNoteModal(): void { new CreateNoteModal(this.app, this).open(); }
  private async currentNodeId(): Promise<string | null> {
    const active = this.app.workspace.getActiveFile();
    if (!active) return null;
    const raw = await this.app.vault.cachedRead(active);
    if (!isNodeFile(raw)) return null;
    const nodes = await this.store.listNodes();
    for (const node of nodes) if (await this.store.nodeFilePath(node.id) === active.path) return node.id;
    return null;
  }
  private async shareSelection(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) return;
    const nodeId = await this.currentNodeId();
    if (nodeId) { const share = await this.store.createShare(nodeId, selection); await this.copyShareUrl(share.id); return; }
    const file = this.app.workspace.getActiveFile();
    if (file) await this.sharePath(file.path, selection);
  }
  private async shareCurrentFile(): Promise<void> { const file = this.app.workspace.getActiveFile(); if (file) await this.sharePath(file.path); }
  private async sharePath(relPath: string, selection?: string): Promise<void> {
    try { const share = await this.store.createPathShare(relPath, undefined, selection); await this.copyShareUrl(share.id); }
    catch (error) { new Notice(`分享失败：${(error as Error).message}`); }
  }
  async copyShareUrl(id: string): Promise<void> {
    const port = this.server?.port ?? this.settings.port;
    const url = `http://127.0.0.1:${port}/api/shares/${id}/resolve`;
    await navigator.clipboard.writeText(url);
    new Notice("分享地址已复制，直接发给 agent 即可。", 4000);
  }
  async loadSettings(): Promise<void> { const saved = await this.loadData(); this.settings = { ...DEFAULT_SETTINGS, ...saved, agents: saved?.agents ?? {} }; }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

class CreateNoteModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: "新建笔记" });
    let title = "", content = "", background = "";
    new Setting(this.contentEl).setName("标题").addText((input) => input.onChange((value) => title = value));
    new Setting(this.contentEl).setName("正文").addTextArea((input) => input.onChange((value) => content = value));
    new Setting(this.contentEl).setName("背景").setDesc("这是什么、从哪来、为什么保存").addTextArea((input) => input.onChange((value) => background = value));
    new Setting(this.contentEl).addButton((button) => button.setButtonText("创建").setCta().onClick(async () => {
      try { const node = await this.plugin.store.createNode({ title, content, background, source: "user" }); this.close(); new Notice(`已创建笔记：${node.title}`); this.plugin.refreshPanels(); }
      catch (error) { new Notice((error as Error).message); }
    }));
  }
}

class AgentNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty(); this.containerEl.createEl("h2", { text: "agentNote" });
    new Setting(this.containerEl).setName("本地服务端口").setDesc("agent 通过此端口读取分享和写入笔记。").addText((input) => input.setValue(String(this.plugin.settings.port)).onChange(async (value) => { const port = Number(value); if (Number.isInteger(port) && port > 0 && port < 65536) { this.plugin.settings.port = port; await this.plugin.saveSettings(); } }));
    new Setting(this.containerEl).setName("启动 Obsidian 时运行服务").addToggle((toggle) => toggle.setValue(this.plugin.settings.autostartServer).onChange(async (value) => { this.plugin.settings.autostartServer = value; await this.plugin.saveSettings(); }));
    this.containerEl.createEl("p", { text: "agent 的安装、提示词与接入状态在 agentNote 接入台中管理。" });
  }
}
