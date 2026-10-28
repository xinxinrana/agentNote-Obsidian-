import { languageForPreference, setLanguage, t } from "./i18n";
import type { LanguagePreference } from "./i18n";
import * as os from "os";
import * as path from "path";
import { App, Editor, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, addIcon, getLanguage, parseLinktext, removeIcon } from "obsidian";
import { AgentServer } from "./core/server";
import type { AgentActivity, ShareLinkInfo } from "./core/server";
import { AgentConnections, connectionsFile } from "./core/agentConnections";
import type { AgentConnection } from "./core/agentConnections";
import { isNewerVersion } from "./core/version";
import { StoreError, VaultStore } from "./core/store";
import { isLocalActivityBurst } from "./core/activityLog";
import { isNodeFile } from "./core/nodeFile";
import { selectionSnippet } from "./core/selection";
import { fetchLatestRelease, installRelease, ReleaseInfo } from "./updater";
import { AGENTNOTE_VIEW, AgentNoteView, BulkActivityModal, QuickStartModal } from "./ui/panel";
import xiaojiMarkUrl from "../assets/brand/xiaoji-mark.svg";

export interface AgentProfile { enabled: boolean; instructions: string; template?: string }
export interface LiveAgentActivity extends AgentActivity { at: string; agentName: string; sessionTitle?: string }
type BulkActivityAction = "ask" | "record" | "ignore";
interface AgentNoteSettings { language: LanguagePreference; port: number; autostartServer: boolean; showQuickStart: boolean; coldBackupEnabled: boolean; coldBackupDelayMinutes: number; bulkActivityAction: BulkActivityAction; agents: Record<string, AgentProfile> }
const DEFAULT_SETTINGS: AgentNoteSettings = { language: "auto", port: 27182, autostartServer: true, showQuickStart: true, coldBackupEnabled: true, coldBackupDelayMinutes: 3, bulkActivityAction: "ask", agents: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export default class AgentNotePlugin extends Plugin {
  settings: AgentNoteSettings = DEFAULT_SETTINGS;
  store!: VaultStore;
  connections!: AgentConnections;
  server: AgentServer | null = null;
  serverPortInUse = false;
  private portConflictModal: PortConflictModal | null = null;
  private panelRefreshTimer: number | null = null;
  private coldBackupTimer: number | null = null;
  private coldBackupTask: Promise<{ created: number; existing: number }> | null = null;
  private localEditTimers = new Map<string, number>();
  private localReadTimer: number | null = null;
  private localActivityTimer: number | null = null;
  private pendingLocalActivities: { type: "local-created" | "local-edited" | "local-moved" | "local-deleted"; path: string; at: number; oldPath?: string; references?: boolean; bulkSession?: boolean }[] = [];
  private localActivityTask: Promise<void> = Promise.resolve();
  private bulkChoiceTask: Promise<boolean> | null = null;
  private bulkModal: BulkActivityModal | null = null;
  private recentBulkChoice: { record: boolean; until: number } | null = null;
  private suppressedLocalRenames = new Set<string>();

  async onload(): Promise<void> {
    setLanguage(getLanguage());
    try { await this.loadSettings(); }
    catch (error) {
      this.settings = { ...DEFAULT_SETTINGS, agents: {} };
      new Notice(t("插件设置无法读取，已使用默认设置。原文件已保留：{0}", (error as Error).message), 10000);
    }
    setLanguage(languageForPreference(this.settings.language, getLanguage()));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice(t("agentNote 需要桌面端文件系统 vault。")); return; }
    this.store = new VaultStore(adapter.getBasePath(), this.app.vault.configDir);
    try { await this.store.init(); }
    catch (error) { new Notice(t("数据初始化失败，仍可打开接入台检查：{0}", (error as Error).message), 10000); }
    this.connections = new AgentConnections(connectionsFile(os.homedir()));
    this.addSettingTab(new AgentNoteSettingTab(this.app, this));
    this.registerView(AGENTNOTE_VIEW, (leaf) => new AgentNoteView(leaf, this));
    const mark = new DOMParser().parseFromString(decodeURIComponent(xiaojiMarkUrl.slice(xiaojiMarkUrl.indexOf(",") + 1)), "image/svg+xml").documentElement;
    mark.querySelector("title")?.remove();
    mark.querySelectorAll("path").forEach((shape) => { shape.setAttribute("fill", "none"); shape.setAttribute("stroke", "currentColor"); });
    mark.querySelectorAll("ellipse").forEach((shape) => shape.setAttribute("fill", "currentColor"));
    addIcon("agentnote-mark", `<g transform="scale(0.78125)">${mark.innerHTML}</g>`);
    this.addRibbonIcon("agentnote-mark", t("打开 agentNote 接入台"), () => void this.activatePanel());
    this.addCommand({ id: "open-panel", name: t("打开接入台"), callback: () => void this.activatePanel() });
    this.addCommand({ id: "create-note", name: t("新建笔记"), callback: () => this.openCreateNoteModal() });
    this.addCommand({ id: "share-selection", name: t("分享选中内容"), editorCallback: (editor) => void this.shareSelection(editor) });
    this.addCommand({ id: "share-current-note", name: t("分享当前文件"), callback: () => void this.shareCurrentFile() });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!editor.getSelection()) return;
      menu.addItem((item) => item.setTitle(t("agentNote: 分享选中内容")).setIcon("link").onClick(() => void this.shareSelection(editor)));
    }));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      menu.addItem((item) => item.setTitle(t("agentNote: 分享给 agent")).setIcon("link").onClick(() => void this.sharePath(file.path)));
    }));
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      if (files.length < 2) return;
      menu.addItem((item) => item.setTitle(t("agentNote: 分享选中项目给 agent")).setIcon("link").onClick(() => void this.sharePaths(files)));
    }));
    this.app.workspace.onLayoutReady(() => this.registerLocalActivityTracking());
    this.scheduleColdBackup();
    if (this.settings.autostartServer) await this.startServer(true);
  }
  onunload(): void {
    removeIcon("agentnote-mark");
    this.portConflictModal?.close();
    this.bulkModal?.close();
    if (this.panelRefreshTimer !== null) window.clearTimeout(this.panelRefreshTimer);
    if (this.coldBackupTimer !== null) window.clearTimeout(this.coldBackupTimer);
    if (this.localReadTimer !== null) window.clearTimeout(this.localReadTimer);
    if (this.localActivityTimer !== null) { window.clearTimeout(this.localActivityTimer); void this.flushLocalActivities(true); }
    for (const timer of this.localEditTimers.values()) window.clearTimeout(timer);
    void this.stopServer(true);
  }
  async activatePanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: AGENTNOTE_VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  refreshPanels(): void { for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) if (leaf.view instanceof AgentNoteView) void leaf.view.refresh(); }
  scheduleColdBackup(): void {
    if (this.coldBackupTimer !== null) window.clearTimeout(this.coldBackupTimer);
    this.coldBackupTimer = null;
    if (!this.settings.coldBackupEnabled) return;
    this.coldBackupTimer = window.setTimeout(() => {
      this.coldBackupTimer = null;
      void this.runColdBackup().catch((error: Error) => new Notice(t("冷备份失败：{0}", error.message)));
    }, this.settings.coldBackupDelayMinutes * 60_000);
  }
  runColdBackup(): Promise<{ created: number; existing: number }> {
    if (!this.coldBackupTask) this.coldBackupTask = this.store.backupPastDays().finally(() => { this.coldBackupTask = null; });
    return this.coldBackupTask;
  }
  private recordAgentActivity(activity: AgentActivity): void {
    const latest: LiveAgentActivity = {
      ...activity,
      at: new Date().toISOString(),
      agentName: activity.actor?.name ?? activity.actor?.id ?? (activity.operation === "read" ? t("分享链接") : t("未识别 agent")),
      sessionTitle: activity.actor?.sessionTitle,
    };
    for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) if (leaf.view instanceof AgentNoteView) leaf.view.showAgentActivity(latest);
    if (activity.operation === "created" && activity.targetKind !== "folder") this.schedulePanelRefresh(1_450);
  }
  schedulePanelRefresh(delay = 500): void {
    if (this.panelRefreshTimer !== null) {
      if (delay === 500) return;
      window.clearTimeout(this.panelRefreshTimer);
    }
    this.panelRefreshTimer = window.setTimeout(() => { this.panelRefreshTimer = null; this.refreshPanels(); }, delay);
  }
  private registerLocalActivityTracking(): void {
    this.registerEvent(this.app.vault.on("create", (file) => this.trackCreatedFile(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.trackModifiedFile(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.trackDeletedFile(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.trackMovedFile(file, oldPath)));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.trackReadFile(file)));
  }
  private isTrackedMarkdown(file: TAbstractFile | null): file is TFile {
    return file instanceof TFile && file.extension.toLowerCase() === "md" && !file.path.startsWith(`${this.app.vault.configDir}/`) && !file.path.startsWith("agentNote/data/");
  }
  private recordLocalActivity(type: "local-created" | "local-edited" | "local-read" | "local-moved" | "local-deleted", filePath: string, oldPath?: string): void {
    if (type !== "local-read") {
      const now = Date.now();
      const bulkSession = !!this.bulkChoiceTask || !!(this.recentBulkChoice && now < this.recentBulkChoice.until);
      if (bulkSession && this.recentBulkChoice) this.recentBulkChoice.until = now + 1_000;
      this.pendingLocalActivities.push({ type, path: filePath, at: now, oldPath, references: type === "local-created" || type === "local-edited", bulkSession });
      if (this.localActivityTimer !== null) window.clearTimeout(this.localActivityTimer);
      if (isLocalActivityBurst(this.pendingLocalActivities)) void this.flushLocalActivities();
      else this.localActivityTimer = window.setTimeout(() => void this.flushLocalActivities(), 1_000);
      return;
    }
    void this.store.recordLocalActivity(type, filePath, oldPath)
      .then((recorded) => { if (recorded) this.schedulePanelRefresh(); })
      .catch((error) => { new Notice(t("本次活动未记录：{0}", error instanceof Error ? error.message : String(error))); this.schedulePanelRefresh(); });
  }
  private async chooseBulkActivity(count: number): Promise<boolean> {
    if (this.settings.bulkActivityAction !== "ask") return this.settings.bulkActivityAction === "record";
    if (this.bulkChoiceTask) return this.bulkChoiceTask;
    if (this.recentBulkChoice && Date.now() < this.recentBulkChoice.until) return this.recentBulkChoice.record;
    this.bulkChoiceTask = new Promise<boolean>((resolve) => {
      this.bulkModal = new BulkActivityModal(this.app, count, (record, remember) => {
        this.bulkModal = null;
        if (remember) { this.settings.bulkActivityAction = record ? "record" : "ignore"; void this.saveSettings(); }
        this.recentBulkChoice = { record, until: Date.now() + 1_000 };
        resolve(record);
      });
      this.bulkModal.open();
    });
    try { return await this.bulkChoiceTask; }
    finally { this.bulkChoiceTask = null; }
  }
  private flushLocalActivities(unloading = false): Promise<void> {
    if (this.localActivityTimer !== null) window.clearTimeout(this.localActivityTimer);
    this.localActivityTimer = null;
    const batch = this.pendingLocalActivities.splice(0);
    if (!batch.length) return this.localActivityTask;
    const task = this.localActivityTask.then(async () => {
      const burst = isLocalActivityBurst(batch) || batch.some((item) => item.bulkSession);
      const record = !burst || (unloading && this.settings.bulkActivityAction === "ask" ? false : await this.chooseBulkActivity(batch.length));
      for (const item of batch) {
        try {
          const updated = await this.store.recordLocalActivity(item.type, item.path, item.oldPath, record);
          if (record && updated && !unloading && item.type === "local-created") {
            this.schedulePanelRefresh(1_450);
          } else if (updated && !unloading) {
            this.schedulePanelRefresh();
          }
          if (item.references) {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) this.trackDocumentReferences(file, record);
          }
        } catch (error) { new Notice(t("本次活动未记录：{0}", error instanceof Error ? error.message : String(error))); this.schedulePanelRefresh(); }
      }
    });
    this.localActivityTask = task.catch(() => undefined);
    return task;
  }
  private trackCreatedFile(file: TAbstractFile): void {
    if (this.isTrackedMarkdown(file)) {
      this.recordLocalActivity("local-created", file.path);
    }
  }
  private trackModifiedFile(file: TAbstractFile): void {
    if (!this.isTrackedMarkdown(file)) return;
    const previous = this.localEditTimers.get(file.path);
    if (previous !== undefined) window.clearTimeout(previous);
    this.localEditTimers.set(file.path, window.setTimeout(() => {
      this.localEditTimers.delete(file.path);
      this.recordLocalActivity("local-edited", file.path);
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
    if (!(file instanceof TFile)) throw new Error(t("原文档不存在"));
    if (this.app.vault.getAbstractFileByPath(destinationPath)) throw new Error(t("目标位置已有同名文档"));
    this.suppressedLocalRenames.add(sourcePath);
    try { await this.app.fileManager.renameFile(file, destinationPath); }
    catch (error) { this.suppressedLocalRenames.delete(sourcePath); throw error; }
    window.setTimeout(() => this.suppressedLocalRenames.delete(sourcePath), 5_000);
    try { await this.store.recordLocalActivity("local-moved", destinationPath, sourcePath); }
    catch { new Notice(t("文档已移动，但活动记录未更新；请检查已有分享链接。")); }
    this.schedulePanelRefresh();
  }
  async archiveVaultDocument(sourcePath: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) throw new Error(t("原文档不存在"));
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
  private async listShareLinks(sourcePath: string): Promise<ShareLinkInfo[]> {
    const file = this.app.vault.getFileByPath(sourcePath);
    if (!file) throw new StoreError(404, t("来源笔记不存在: {0}", sourcePath));
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) throw new StoreError(503, t("来源笔记的双链索引尚未就绪"));
    return (cache.links ?? []).map(({ original, link, displayText }) => {
      const { path: linkPath, subpath } = parseLinktext(link);
      const target = linkPath ? this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path) : file;
      return { original, link, ...(displayText ? { displayText } : {}), targetPath: target?.path ?? null, subpath: subpath || null, status: target ? "resolved" : "unresolved" };
    });
  }
  private trackDocumentReferences(file: TFile, recordAdditions: boolean): void {
    if (!this.isTrackedMarkdown(file)) return;
    void this.store.recordDocumentReferences(file.path, this.referenceTargets(file), recordAdditions)
      .then(() => { if (recordAdditions) this.schedulePanelRefresh(); })
      .catch(() => this.schedulePanelRefresh());
  }
  connectedAgents(): Promise<AgentConnection[]> { return this.connections.list(); }
  async forgetAgent(name: string): Promise<void> { await this.connections.remove(name); this.refreshPanels(); }
  async saveConnectedSkill(connection: AgentConnection, expected: string, updated: string): Promise<void> {
    await this.connections.saveSkill(connection, expected, updated);
    this.refreshPanels();
  }
  async startServer(quiet = false): Promise<void> {
    if (this.server) return;
    this.server = new AgentServer(this.store, { port: this.settings.port, onActivity: (activity) => this.recordAgentActivity(activity), listLinks: (sourcePath) => this.listShareLinks(sourcePath), registerAgent: async (name, skillPath, iconPath) => {
      const connection = await this.connections.register(name, skillPath, iconPath);
      this.refreshPanels();
      return connection;
    } });
    try {
      await this.server.start();
      this.serverPortInUse = false;
      this.portConflictModal?.close();
      if (!quiet) new Notice(t("agentNote 服务已启动：127.0.0.1:{0}", this.server.port));
    } catch (error) {
      this.server = null;
      this.serverPortInUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      new Notice(this.serverPortInUse
        ? t("端口 {0} 已被占用。若另一个仓库正在分享，请先在那个仓库的接入台停止服务，再回到这里点击启动服务。", this.settings.port)
        : t("agentNote 服务启动失败：{0}", (error as Error).message), 10000);
      if (this.serverPortInUse) this.app.workspace.onLayoutReady(() => {
        if (!this.serverPortInUse || this.portConflictModal) return;
        this.portConflictModal = new PortConflictModal(this.app, this.settings.port, () => { this.portConflictModal = null; });
        this.portConflictModal.open();
      });
    }
    this.refreshPanels();
  }
  async stopServer(quiet = false): Promise<void> { if (!this.server) return; await this.server.stop(); this.server = null; if (!quiet) new Notice(t("agentNote 服务已停止。")); this.refreshPanels(); }
  async applyUpdate(release: ReleaseInfo): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("agentNote 需要桌面端文件系统 vault。"));
    const dir = path.join(adapter.getBasePath(), this.manifest.dir ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id));
    await installRelease(dir, release);
    new Notice(t("agentNote 已更新到 v{0}，正在重载插件。", release.version));
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
    // Rendered tables and wiki links do not round-trip to their Markdown source, so trust the
    // editor offsets when the selected text is not verbatim in the file.
    const source = editor.getValue();
    const selectionStart = editor.posToOffset(editor.getCursor("from"));
    const selection = selectionSnippet(source, editor.getSelection(), selectionStart, editor.posToOffset(editor.getCursor("to")));
    if (!selection) return;
    try {
      this.shareServicePort();
      const nodeId = await this.currentNodeId();
      if (nodeId) {
        const node = await this.store.getNode(nodeId);
        const frontmatterEnd = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source)?.[0].length ?? 0;
        const bodyStart = source.indexOf(node.content, frontmatterEnd);
        const start = bodyStart >= 0 && selectionStart >= bodyStart ? selectionStart - bodyStart : undefined;
        const share = await this.store.createShare(nodeId, selection, {}, start);
        await this.copyShareLink(share.id, node.title); return;
      }
      const file = this.app.workspace.getActiveFile();
      if (file) await this.shareFileFromPanel(file.path, selection, selectionStart);
    } catch (error) { new Notice(t("分享失败：{0}", (error as Error).message)); }
  }
  private async shareCurrentFile(): Promise<void> { const file = this.app.workspace.getActiveFile(); if (file) await this.sharePath(file.path); }
  private async sharePath(relPath: string, selection?: string): Promise<void> {
    await this.shareFileFromPanel(relPath, selection);
  }
  async shareFileFromPanel(relPath: string, selection?: string, selectionStart?: number): Promise<boolean> {
    try {
      this.shareServicePort();
      const share = await this.store.createPathShare(relPath, undefined, selection, {}, selectionStart);
      await this.copyShareLink(share.id, path.basename(relPath));
      return true;
    } catch (error) {
      new Notice(t("分享失败：{0}", (error as Error).message));
      return false;
    }
  }
  private async sharePaths(files: TAbstractFile[]): Promise<void> {
    try { this.shareServicePort(); }
    catch (error) { new Notice(t("分享失败：{0}", (error as Error).message)); return; }
    // One link for the whole selection, so the receiver knows it got a set of files instead of one document.
    try {
      const share = await this.store.createFilesShare(files.map((file) => file.path));
      const rich = await this.writeShareLinks([{ id: share.id, title: t("{0} 个文件", files.length) }]);
      new Notice(rich ? t("已复制 {0} 个文件的分享链接，直接发给 agent 即可。", files.length) : t("已复制 {0} 个文件的纯文本分享链接。", files.length), 4000);
    } catch (error) { new Notice(t("分享失败：{0}", (error as Error).message), 7000); }
  }
  private shareServicePort(): number {
    const port = this.server?.port;
    if (!port) throw new Error(t("当前仓库的本地服务未运行，请先在接入台启动服务。"));
    return port;
  }
  private shareUrl(id: string): string { return `http://127.0.0.1:${this.shareServicePort()}/api/shares/${id}/resolve`; }
  private shareMarkdownLink(id: string, title: string): string {
    const label = title.replace(/[\\[\]]/g, (character) => `\\${character}`);
    return `[${label}](${this.shareUrl(id)})`;
  }
  private async writeShareLinks(links: { id: string; title: string }[]): Promise<boolean> {
    this.shareServicePort();
    const text = links.map(({ id, title }) => this.shareMarkdownLink(id, title)).join("\n\n---\n\n");
    const html = links.map(({ id, title }) => {
      const label = title.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
      return `<a href="${this.shareUrl(id)}">${label}</a>`;
    }).join("<br><br>");
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return true;
    } catch {
      await navigator.clipboard.writeText(text);
      return false;
    }
  }
  async copyShareLink(id: string, title: string): Promise<void> {
    const rich = await this.writeShareLinks([{ id, title }]);
    new Notice(rich ? t("分享链接已复制，直接发给 agent 即可。") : t("已复制纯文本分享链接。"), 4000);
  }
  async loadSettings(): Promise<void> {
    const saved: unknown = await this.loadData() as unknown;
    const settings = isRecord(saved) ? saved : {};
    this.settings = {
      language: settings.language === "zh" || settings.language === "en" ? settings.language : "auto",
      port: typeof settings.port === "number" ? settings.port : DEFAULT_SETTINGS.port,
      autostartServer: typeof settings.autostartServer === "boolean" ? settings.autostartServer : DEFAULT_SETTINGS.autostartServer,
      showQuickStart: typeof settings.showQuickStart === "boolean" ? settings.showQuickStart : DEFAULT_SETTINGS.showQuickStart,
      coldBackupEnabled: typeof settings.coldBackupEnabled === "boolean" ? settings.coldBackupEnabled : DEFAULT_SETTINGS.coldBackupEnabled,
      coldBackupDelayMinutes: typeof settings.coldBackupDelayMinutes === "number" && Number.isInteger(settings.coldBackupDelayMinutes) && settings.coldBackupDelayMinutes >= 1 && settings.coldBackupDelayMinutes <= 60 ? settings.coldBackupDelayMinutes : DEFAULT_SETTINGS.coldBackupDelayMinutes,
      bulkActivityAction: settings.bulkActivityAction === "record" || settings.bulkActivityAction === "ignore" ? settings.bulkActivityAction : "ask",
      agents: isRecord(settings.agents) ? settings.agents as Record<string, AgentProfile> : {},
    };
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

class PortConflictModal extends Modal {
  constructor(app: App, private port: number, private dismissed: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("端口被占用，当前仓库尚未开始分享") });
    this.contentEl.createEl("p", { text: t("本机端口 {0} 正被占用。如果另一个仓库正在使用 agentNote，请先到那个仓库的接入台点击“停止服务”，再回到当前仓库点击“重试启动”。", this.port) });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(t("我知道了")).setCta().onClick(() => this.close()));
  }
  onClose(): void { this.dismissed(); this.contentEl.empty(); }
}

class CreateNoteModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: t("新建笔记") });
    let title = "", content = "", background = "";
    new Setting(this.contentEl).setName(t("标题")).addText((input) => input.onChange((value) => title = value));
    new Setting(this.contentEl).setName(t("正文")).addTextArea((input) => input.onChange((value) => content = value));
    new Setting(this.contentEl).setName(t("背景")).setDesc(t("这是什么、从哪来、为什么保存")).addTextArea((input) => input.onChange((value) => background = value));
    new Setting(this.contentEl).addButton((button) => button.setButtonText(t("创建")).setCta().onClick(async () => {
      try { const node = await this.plugin.store.createNode({ title, content, background, source: "user" }); this.close(); new Notice(t("已创建笔记：{0}", node.title)); this.plugin.refreshPanels(); }
      catch (error) { new Notice((error as Error).message); }
    }));
  }
}

class AgentNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName(t("语言与显示")).setHeading();
    new Setting(this.containerEl)
      .setName(t("界面语言"))
      .setDesc(t("优先使用这里选择的语言；选择自动时跟随 Obsidian。命令和菜单名称在重启 Obsidian 后更新。"))
      .addDropdown((dropdown) => dropdown.addOptions({ auto: t("自动（跟随 Obsidian）"), zh: t("简体中文"), en: "English" }).setValue(this.plugin.settings.language).onChange(async (value) => {
        this.plugin.settings.language = value as LanguagePreference;
        setLanguage(languageForPreference(this.plugin.settings.language, getLanguage()));
        await this.plugin.saveSettings();
        this.display();
        this.plugin.refreshPanels();
      }));
    new Setting(this.containerEl)
      .setName(t("连接 Agent"))
      .setDesc(t("Agent 的安装和提示词在接入台管理；这里设置插件与 Agent 的连接方式。"))
      .setHeading();
    new Setting(this.containerEl)
      .setName(t("管理 Agent 接入"))
      .setDesc(t("查看接入状态、安装 Agent，或修改已接入的提示词。"))
      .addButton((button) => button.setButtonText(t("前往接入台")).setCta().onClick(async () => {
        (this.app as App & { setting: { close(): void } }).setting.close();
        await this.plugin.activatePanel();
      }));
    new Setting(this.containerEl)
      .setName(t("打开 Obsidian 时启动本地服务"))
      .setDesc(t("服务运行时，Agent 才能通过分享链接读取内容或写入笔记。"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autostartServer).onChange(async (value) => {
        this.plugin.settings.autostartServer = value;
        await this.plugin.saveSettings();
      }));
    new Setting(this.containerEl)
      .setName(t("本地服务端口"))
      .setDesc(t("通常无需修改。默认 27182；修改后重启 Obsidian，并让已接入的 Agent 使用新端口。"))
      .addText((input) => input.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
        const port = Number(value);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          this.plugin.settings.port = port;
          await this.plugin.saveSettings();
        }
      }));

    new Setting(this.containerEl)
      .setName(t("活动记录"))
      .setDesc(t("决定大量本地文件变动是否显示为活动，并保存历史活动副本。"))
      .setHeading();
    new Setting(this.containerEl).setName(t("一次改动很多文件时")).setDesc(t("Git 同步或批量导入时，选择是否把这批变化记入活动；不影响文件内容和分享链接。"))
      .addDropdown((dropdown) => dropdown.addOptions({ ask: t("先询问我"), ignore: t("不计入活动"), record: t("计入活动") }).setValue(this.plugin.settings.bulkActivityAction).onChange(async (value) => {
        this.plugin.settings.bulkActivityAction = value as BulkActivityAction;
        await this.plugin.saveSettings();
      }));
    new Setting(this.containerEl)
      .setName(t("自动备份历史活动"))
      .setDesc(t("按天保留过去的活动记录副本；不备份笔记正文，也不影响活动统计。"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.coldBackupEnabled).onChange(async (value) => {
        this.plugin.settings.coldBackupEnabled = value;
        await this.plugin.saveSettings();
        this.plugin.scheduleColdBackup();
        this.display();
      }));
    if (this.plugin.settings.coldBackupEnabled) {
      new Setting(this.containerEl)
        .setName(t("启动后多久备份"))
        .setDesc(t("打开 Obsidian 后等待 1–60 分钟再开始，避免影响启动。"))
        .addText((input) => input.setValue(String(this.plugin.settings.coldBackupDelayMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return;
          this.plugin.settings.coldBackupDelayMinutes = minutes;
          await this.plugin.saveSettings();
          this.plugin.scheduleColdBackup();
        }));
    }
    new Setting(this.containerEl)
      .setName(t("手动备份历史活动"))
      .setDesc(t("立即保存过去日期的活动记录；已有副本不会覆盖。"))
      .addButton((button) => button.setButtonText(t("立即备份")).onClick(async () => {
        button.setDisabled(true);
        try {
          const result = await this.plugin.runColdBackup();
          new Notice(t("活动记录备份完成：新增 {0} 份，已有 {1} 份未改动。", result.created, result.existing));
        } catch (error) { new Notice(t("活动记录备份失败：{0}", (error as Error).message)); }
        finally { button.setDisabled(false); }
      }));

    new Setting(this.containerEl).setName(t("帮助与更新")).setHeading();
    new Setting(this.containerEl)
      .setName(t("接入教程"))
      .setDesc(t("在接入台顶部显示快速教程，也可以随时打开查看。"))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showQuickStart).onChange(async (value) => {
        this.plugin.settings.showQuickStart = value;
        await this.plugin.saveSettings();
        this.plugin.refreshPanels();
        if (value) new Notice(t("快速教程已重新显示在接入台顶部。"));
      }))
      .addButton((button) => button.setButtonText(t("打开教程")).onClick(() => new QuickStartModal(this.app).open()));
    const update = new Setting(this.containerEl)
      .setName(t("当前版本 v{0}", this.plugin.manifest.version))
      .setDesc(t("作者 Evan。检查 GitHub 上的新版本；更新完成后插件会自动重载。"))
      .addButton((check) => check.setButtonText(t("检查更新")).onClick(async () => {
        check.setButtonText(t("检查中…")).setDisabled(true);
        try {
          const release = await fetchLatestRelease();
          if (!isNewerVersion(release.version, this.plugin.manifest.version)) {
            update.setDesc(t("已是最新版本（GitHub 最新为 v{0}）。", release.version));
            return;
          }
          update.setDesc(t("发现新版本 v{0}。", release.version));
          update.addButton((upgrade) => upgrade.setButtonText(t("更新到 v{0}", release.version)).setCta().onClick(async () => {
            upgrade.setButtonText(t("更新中…")).setDisabled(true);
            try { await this.plugin.applyUpdate(release); }
            catch (error) { new Notice(t("更新失败：{0}", (error as Error).message)); upgrade.setButtonText(t("重试更新")).setDisabled(false); }
          }));
        } catch (error) {
          update.setDesc(t("检查失败：{0}", (error as Error).message));
        } finally {
          check.setButtonText(t("检查更新")).setDisabled(false);
        }
      }));
  }
}
