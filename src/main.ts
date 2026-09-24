import * as os from "os";
import * as path from "path";
import { App, Editor, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from "obsidian";
import { AgentServer } from "./core/server";
import type { AgentActivity } from "./core/server";
import { detectAgents, DetectedAgent, installSkill, uninstallSkill } from "./core/skill";
import { isNewerVersion } from "./core/version";
import { VaultStore } from "./core/store";
import { isNodeFile } from "./core/nodeFile";
import { fetchLatestRelease, installRelease, ReleaseInfo } from "./updater";
import { AGENTNOTE_VIEW, AgentNoteView, QuickStartModal } from "./ui/panel";

export interface AgentProfile { enabled: boolean; instructions: string; template?: string }
export interface LiveAgentActivity extends AgentActivity { at: string; agentName: string; sessionTitle?: string }
interface AgentNoteSettings { port: number; autostartServer: boolean; showQuickStart: boolean; agents: Record<string, AgentProfile> }
const DEFAULT_SETTINGS: AgentNoteSettings = { port: 27182, autostartServer: true, showQuickStart: true, agents: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export default class AgentNotePlugin extends Plugin {
  settings: AgentNoteSettings = DEFAULT_SETTINGS;
  store!: VaultStore;
  server: AgentServer | null = null;
  private panelRefreshTimer: number | null = null;
  private localEditTimers = new Map<string, number>();
  private localReadTimer: number | null = null;
  private suppressedLocalRenames = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice("agentNote 需要桌面端文件系统 vault。"); return; }
    this.store = new VaultStore(adapter.getBasePath());
    await this.store.init();
    this.addSettingTab(new AgentNoteSettingTab(this.app, this));
    this.registerView(AGENTNOTE_VIEW, (leaf) => new AgentNoteView(leaf, this));
    this.addRibbonIcon("bot", "打开 agentNote 接入台", () => void this.activatePanel());
    this.addCommand({ id: "open-panel", name: "打开接入台", callback: () => void this.activatePanel() });
    this.addCommand({ id: "create-note", name: "新建笔记", callback: () => this.openCreateNoteModal() });
    this.addCommand({ id: "share-selection", name: "分享选中内容", editorCallback: (editor) => void this.shareSelection(editor) });
    this.addCommand({ id: "share-current-note", name: "分享当前文件", callback: () => void this.shareCurrentFile() });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!editor.getSelection()) return;
      menu.addItem((item) => item.setTitle("agentNote: 分享选中内容").setIcon("link").onClick(() => void this.shareSelection(editor)));
    }));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      menu.addItem((item) => item.setTitle("agentNote: 分享给 agent").setIcon("link").onClick(() => void this.sharePath(file.path)));
    }));
    this.app.workspace.onLayoutReady(() => this.registerLocalActivityTracking());
    if (this.settings.autostartServer) await this.startServer(true);
  }
  onunload(): void {
    if (this.panelRefreshTimer !== null) window.clearTimeout(this.panelRefreshTimer);
    if (this.localReadTimer !== null) window.clearTimeout(this.localReadTimer);
    for (const timer of this.localEditTimers.values()) window.clearTimeout(timer);
    void this.stopServer(true);
  }
  async activatePanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: AGENTNOTE_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  refreshPanels(): void { for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) if (leaf.view instanceof AgentNoteView) void leaf.view.refresh(); }
  private recordAgentActivity(activity: AgentActivity): void {
    const latest: LiveAgentActivity = {
      ...activity,
      at: new Date().toISOString(),
      agentName: activity.actor?.name ?? activity.actor?.id ?? (activity.operation === "read" ? "分享链接" : "未识别 agent"),
      sessionTitle: activity.actor?.sessionTitle,
    };
    for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) if (leaf.view instanceof AgentNoteView) leaf.view.showAgentActivity(latest);
  }
  schedulePanelRefresh(): void {
    if (this.panelRefreshTimer !== null) return;
    this.panelRefreshTimer = window.setTimeout(() => { this.panelRefreshTimer = null; this.refreshPanels(); }, 500);
  }
  private registerLocalActivityTracking(): void {
    this.registerEvent(this.app.vault.on("create", (file) => this.trackCreatedFile(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.trackModifiedFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.trackDeletedFile(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.trackMovedFile(file, oldPath)));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.trackReadFile(file)));
  }
  private isTrackedMarkdown(file: TAbstractFile | null): file is TFile {
    return file instanceof TFile && file.extension.toLowerCase() === "md" && !file.path.startsWith(".obsidian/") && !file.path.startsWith("agentNote/data/");
  }
  private recordLocalActivity(type: "local-created" | "local-edited" | "local-read" | "local-moved" | "local-deleted", filePath: string, oldPath?: string): void {
    void this.store.recordLocalActivity(type, filePath, oldPath)
      .then((recorded) => { if (recorded) this.schedulePanelRefresh(); })
      .catch(() => undefined);
  }
  private trackCreatedFile(file: TAbstractFile): void {
    if (this.isTrackedMarkdown(file)) {
      this.recordLocalActivity("local-created", file.path);
      window.setTimeout(() => this.trackDocumentReferences(file, true), 500);
    }
  }
  private trackModifiedFile(file: TAbstractFile): void {
    if (!this.isTrackedMarkdown(file)) return;
    const previous = this.localEditTimers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);
    this.localEditTimers.set(file.path, window.setTimeout(() => {
      this.localEditTimers.delete(file.path);
      this.recordLocalActivity("local-edited", file.path);
      this.trackDocumentReferences(file, true);
    }, 20_000));
  }
  private trackDeletedFile(file: TAbstractFile): void {
    if (!this.isTrackedMarkdown(file)) return;
    const pending = this.localEditTimers.get(file.path);
    if (pending !== undefined) { window.clearTimeout(pending); this.localEditTimers.delete(file.path); }
    this.recordLocalActivity("local-deleted", file.path);
  }
  private trackMovedFile(file: TAbstractFile, oldPath: string): void {
    if (!this.isTrackedMarkdown(file) || !oldPath.toLowerCase().endsWith(".md")) return;
    if (this.suppressedLocalRenames.delete(oldPath)) return;
    const pending = this.localEditTimers.get(oldPath);
    if (pending !== undefined) { window.clearTimeout(pending); this.localEditTimers.delete(oldPath); }
    this.recordLocalActivity("local-moved", file.path, oldPath);
  }
  async moveVaultDocument(sourcePath: string, destinationPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) throw new Error("原文档不存在");
    if (this.app.vault.getAbstractFileByPath(destinationPath)) throw new Error("目标位置已有同名文档");
    this.suppressedLocalRenames.add(sourcePath);
    try { await this.app.fileManager.renameFile(file, destinationPath); }
    catch (error) { this.suppressedLocalRenames.delete(sourcePath); throw error; }
    window.setTimeout(() => this.suppressedLocalRenames.delete(sourcePath), 5_000);
    try { await this.store.recordLocalActivity("local-moved", destinationPath, sourcePath); }
    catch { new Notice("文档已移动，但活动记录未更新；请检查已有分享链接。"); }
    this.schedulePanelRefresh();
  }
  async archiveVaultDocument(sourcePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) throw new Error("原文档不存在");
    const folderPath = "agentNote/归档文件";
    if (!this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath);
    let destinationPath = `${folderPath}/${file.name}`;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(destinationPath); suffix++) destinationPath = `${folderPath}/${file.basename} ${suffix}.${file.extension}`;
    await this.moveVaultDocument(sourcePath, destinationPath);
    return destinationPath;
  }
  private trackReadFile(file: TFile | null): void {
    if (this.localReadTimer !== null) window.clearTimeout(this.localReadTimer);
    this.localReadTimer = null;
    if (!this.isTrackedMarkdown(file)) return;
    this.trackDocumentReferences(file, false);
    const filePath = file.path;
    this.localReadTimer = window.setTimeout(() => {
      this.localReadTimer = null;
      if (this.app.workspace.getActiveFile()?.path === filePath) this.recordLocalActivity("local-read", filePath);
    }, 20_000);
  }
  private referenceTargets(file: TFile): string[] {
    return [...new Set((this.app.metadataCache.getFileCache(file)?.links ?? []).map((link) => this.app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path).filter((target): target is string => !!target && target.toLowerCase().endsWith(".md")))];
  }
  private trackDocumentReferences(file: TFile, recordAdditions: boolean): void {
    if (!this.isTrackedMarkdown(file)) return;
    void this.store.recordDocumentReferences(file.path, this.referenceTargets(file), recordAdditions)
      .then(() => { if (recordAdditions) this.schedulePanelRefresh(); })
      .catch(() => undefined);
  }
  detectedAgents(): DetectedAgent[] { return detectAgents(os.homedir()); }
  profile(agentId: string): AgentProfile { return this.settings.agents[agentId] ?? { enabled: true, instructions: "" }; }
  async saveProfile(agentId: string, profile: AgentProfile): Promise<void> { this.settings.agents[agentId] = profile; await this.saveSettings(); }
  async installAgent(agent: DetectedAgent): Promise<void> {
    const profile = this.profile(agent.id);
    try {
      installSkill(agent.skillDir, { port: this.server?.port ?? this.settings.port, instructions: profile.instructions, agentId: agent.id, agentName: agent.name, template: profile.template });
      await this.store.registerAgent({ id: agent.id, name: agent.name });
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
    this.server = new AgentServer(this.store, { port: this.settings.port, onActivity: (activity) => this.recordAgentActivity(activity) });
    try { await this.server.start(); if (!quiet) new Notice(`agentNote 服务已启动：127.0.0.1:${this.server.port}`); }
    catch (error) { this.server = null; new Notice(`agentNote 服务启动失败：${(error as Error).message}`); }
    this.refreshPanels();
  }
  async stopServer(quiet = false): Promise<void> { if (!this.server) return; await this.server.stop(); this.server = null; if (!quiet) new Notice("agentNote 服务已停止。"); this.refreshPanels(); }
  async applyUpdate(release: ReleaseInfo): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("agentNote 需要桌面端文件系统 vault。");
    const dir = path.join(adapter.getBasePath(), this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
    await installRelease(dir, release);
    new Notice(`agentNote 已更新到 v${release.version}，正在重载插件。`);
    const plugins = (this.app as unknown as { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } }).plugins;
    await plugins.disablePlugin(this.manifest.id);
    await plugins.enablePlugin(this.manifest.id);
  }

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
  async loadSettings(): Promise<void> {
    const saved: unknown = await this.loadData() as unknown;
    const settings = isRecord(saved) ? saved : {};
    this.settings = {
      port: typeof settings.port === "number" ? settings.port : DEFAULT_SETTINGS.port,
      autostartServer: typeof settings.autostartServer === "boolean" ? settings.autostartServer : DEFAULT_SETTINGS.autostartServer,
      showQuickStart: typeof settings.showQuickStart === "boolean" ? settings.showQuickStart : DEFAULT_SETTINGS.showQuickStart,
      agents: isRecord(settings.agents) ? settings.agents as Record<string, AgentProfile> : {},
    };
  }
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
    this.containerEl.empty(); new Setting(this.containerEl).setName("插件设置").setHeading();
    new Setting(this.containerEl).setName("版本与更新").setHeading();
    const update = new Setting(this.containerEl)
      .setName(`当前版本 v${this.plugin.manifest.version} · 作者 Evan`)
      .setDesc("更新来自 GitHub Releases 的构建产物，更新后插件自动重载。")
      .addButton((check) => check.setButtonText("检查更新").onClick(async () => {
        check.setButtonText("检查中…").setDisabled(true);
        try {
          const release = await fetchLatestRelease();
          if (!isNewerVersion(release.version, this.plugin.manifest.version)) {
            update.setDesc(`已是最新版本（GitHub 最新为 v${release.version}）。`);
            return;
          }
          update.setDesc(`发现新版本 v${release.version}。`);
          update.addButton((upgrade) => upgrade.setButtonText(`更新到 v${release.version}`).setCta().onClick(async () => {
            upgrade.setButtonText("更新中…").setDisabled(true);
            try { await this.plugin.applyUpdate(release); }
            catch (error) { new Notice(`更新失败：${(error as Error).message}`); upgrade.setButtonText("重试更新").setDisabled(false); }
          }));
        } catch (error) {
          update.setDesc(`检查失败：${(error as Error).message}`);
        } finally {
          check.setButtonText("检查更新").setDisabled(false);
        }
      }));
    new Setting(this.containerEl).setName("使用教程").setHeading();
    new Setting(this.containerEl)
      .setName("在接入台显示快速教程")
      .setDesc("控制接入台顶部的教程卡片；需要回看时可直接打开教程。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showQuickStart).onChange(async (value) => {
        this.plugin.settings.showQuickStart = value;
        await this.plugin.saveSettings();
        this.plugin.refreshPanels();
        if (value) new Notice("快速教程已重新显示在接入台顶部。");
      }))
      .addButton((button) => button.setButtonText("打开教程").onClick(() => new QuickStartModal(this.app).open()));
    new Setting(this.containerEl).setName("本地服务").setHeading();
    new Setting(this.containerEl).setName("本地服务端口").setDesc("agent 通过此端口读取分享和写入笔记。").addText((input) => input.setValue(String(this.plugin.settings.port)).onChange(async (value) => { const port = Number(value); if (Number.isInteger(port) && port > 0 && port < 65536) { this.plugin.settings.port = port; await this.plugin.saveSettings(); } }));
    new Setting(this.containerEl).setName("启动 Obsidian 时运行服务").addToggle((toggle) => toggle.setValue(this.plugin.settings.autostartServer).onChange(async (value) => { this.plugin.settings.autostartServer = value; await this.plugin.saveSettings(); }));
    this.containerEl.createEl("p", { text: "agent 的安装、提示词与接入状态在 agentNote 接入台中管理。" });
  }
}
