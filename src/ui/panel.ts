import { language, locale, t } from "../i18n";
import { App, ItemView, Menu, Modal, Notice, Setting, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import * as path from "path";
import type AgentNotePlugin from "../main";
import type { LiveAgentActivity } from "../main";
import { KNOWN_AGENTS, renderManualInstallPrompt } from "../core/skill";
import { agentNameKey, splitSkillInstructions, withSkillInstructions, type AgentConnection } from "../core/agentConnections";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import codexIcon from "../assets/agents/codex.png";
import workbuddyIcon from "../assets/agents/workbuddy.png";
import xiaojiMark from "../../assets/brand/xiaoji-mark.svg";
import xiaojiWave from "../../assets/brand/xiaoji-wave.svg";
import { renderWorkflowDemo } from "./workflowDemo";
import { toBlob } from "html-to-image";
import type { DashboardInsights, InsightEvent, InsightNote } from "../core/store";
import type { DataIssue } from "../core/dataRepair";

function renderMacOsReminder(parent: HTMLElement): void {
  const reminder = parent.createDiv({ cls: "agentnote-macos-reminder" });
  const icon = reminder.createSpan({ cls: "agentnote-macos-reminder-icon", attr: { "aria-hidden": "true" } });
  setIcon(icon, "alert-triangle");
  const copy = reminder.createDiv();
  copy.createEl("strong", { text: t("使用前必看") });
  copy.createEl("p", { text: t("macOS 使用提醒：让 Agent 持续工作时，请用 ⌘H 隐藏或最小化 Obsidian。关闭笔记库窗口会停止服务，重新打开笔记库即可恢复。") });
}

export const AGENTNOTE_VIEW = "agentnote-view";
type ActivityLinkTarget = Pick<InsightEvent, "nodeId" | "documentId" | "shareId" | "path"> & Partial<Pick<InsightEvent, "type" | "targetKind">>;

const AGENT_ICONS: Record<string, string> = {
  "claude-code": claudeCodeIcon,
  codex: codexIcon,
  workbuddy: workbuddyIcon,
};

function presetAgentIcon(name: string): string | undefined {
  const preset = KNOWN_AGENTS.find((agent) => agentNameKey(agent.name) === agentNameKey(name));
  return preset ? AGENT_ICONS[preset.id] : undefined;
}

/** 接入时上报的图标优先，其次是内置官方图标；都没有时由调用方提供通用图标。 */
function agentIconUrl(connections: readonly AgentConnection[], name: string): string | undefined {
  const key = agentNameKey(name);
  return connections.find((connection) => connection.icon && agentNameKey(connection.name) === key)?.icon ?? presetAgentIcon(name);
}

function agentAvatar(parent: HTMLElement, connections: readonly AgentConnection[], name: string, fallback: string, cls = "agentnote-activity-icon"): HTMLElement {
  const src = agentIconUrl(connections, name);
  if (!src) { const icon = parent.createSpan({ cls }); setIcon(icon, fallback); return icon; }
  const image = parent.createEl("img", { cls: `${cls} agentnote-agent-avatar`, attr: { src, alt: t("{0} 图标", name) } });
  image.decoding = "async";
  return image;
}

function contributionShade(count: number, min: number, max: number): Record<string, string> {
  const low = Math.log1p(min);
  const high = Math.log1p(max);
  const position = high === low ? 0.5 : (Math.log1p(count) - low) / (high - low);
  return {
    "--agentnote-activity-strength": `${Math.round(28 + position * 62)}%`,
    "--agentnote-activity-darkness": `${Math.round(Math.max(0, position - 0.55) * 30)}%`,
  };
}

export class AgentNoteView extends ItemView {
  private refreshVersion = 0;
  private currentFileCard: HTMLElement | null = null;
  private recentActivityContainer: HTMLElement | null = null;
  private recentActivityList: HTMLElement | null = null;
  private recentActivityEmpty: HTMLElement | null = null;
  private recentActivityToggle: HTMLButtonElement | null = null;
  private recentActivityExpanded = false;
  private pendingAgentActivity: { surface: HTMLElement; copy: HTMLElement; time: HTMLElement; agentName: string; title: string; targetKey: string; operations: LiveAgentActivity["operation"][]; receivedAt: number } | null = null;
  private agentConnections: AgentConnection[] = [];
  constructor(leaf: WorkspaceLeaf, private plugin: AgentNotePlugin) { super(leaf); }
  getViewType(): string { return AGENTNOTE_VIEW; }
  getDisplayText(): string { return t("agentNote 接入台"); }
  getIcon(): string { return "bot"; }
  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("file-open", () => this.renderCurrentFile()));
    await this.refresh();
  }
  async onClose(): Promise<void> { this.refreshVersion++; this.currentFileCard = null; this.recentActivityContainer = null; this.recentActivityList = null; this.recentActivityEmpty = null; this.recentActivityToggle = null; this.pendingAgentActivity = null; this.contentEl.empty(); }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    this.recentActivityContainer = null; this.recentActivityList = null; this.recentActivityEmpty = null; this.recentActivityToggle = null;
    this.contentEl.empty(); this.contentEl.addClass("agentnote-panel");
    const heading = this.contentEl.createDiv({ cls: "agentnote-panel-heading" });
    const brand = heading.createDiv({ cls: "agentnote-panel-brand" });
    brand.createEl("img", { cls: "agentnote-panel-mark", attr: { src: xiaojiMark, alt: "" } });
    brand.createEl("h3", { text: "agentNote" });
    this.currentFileCard = this.contentEl.createDiv({ cls: "agentnote-current-file" });
    this.renderCurrentFile();
    const dashboard = this.contentEl.createDiv();
    dashboard.createEl("p", { text: t("正在加载看板…"), attr: { role: "status" } });
    if (this.plugin.settings.showQuickStart) this.renderQuickStart();
    const activitySection = this.contentEl.createDiv();
    const agentSection = this.contentEl.createDiv();
    this.renderAgents([], agentSection, t("正在读取接入状态…"));
    this.renderServer();
    // Icons are optional decoration: a broken connection record must not delay the dashboard.
    const connectionsReady = this.loadAgentConnections();
    // These sections are independent: a damaged statistics file must not hide
    // service controls or prevent installing and managing local Agents.
    await Promise.all([
      (async () => {
        try {
          const [insights] = await Promise.all([this.plugin.store.getDashboardInsights(), connectionsReady]);
          if (version !== this.refreshVersion) return;
          dashboard.empty();
          this.renderDashboard(insights, dashboard, activitySection);
        } catch (error) {
          if (version !== this.refreshVersion) return;
          dashboard.empty(); activitySection.empty();
          this.renderLoadError(dashboard, t("看板暂时无法加载"), error, true);
        }
      })(),
      (async () => {
        try {
          const connections = await this.plugin.connectedAgents();
          if (version !== this.refreshVersion) return;
          this.agentConnections = connections;
          agentSection.empty();
          this.renderAgents(connections, agentSection);
        } catch (error) {
          if (version !== this.refreshVersion) return;
          agentSection.empty();
          this.renderLoadError(agentSection.createDiv(), t("Agent 接入记录暂时无法加载"), error);
          this.renderAgents([], agentSection, t("接入状态暂时不可用"));
        }
      })(),
    ]);
  }
  private async loadAgentConnections(): Promise<AgentConnection[]> {
    try { this.agentConnections = await this.plugin.connectedAgents(); }
    catch { this.agentConnections = []; }
    return this.agentConnections;
  }
  private renderCurrentFile(): void {
    const card = this.currentFileCard;
    if (!card) return;
    card.empty();
    const file = this.app.workspace.getActiveFile();
    const label = card.createDiv({ cls: "agentnote-current-label" });
    setIcon(label.createSpan(), "file-text");
    label.createSpan({ text: t("当前笔记") });
    card.createEl("h4", { text: file?.basename ?? t("尚未打开笔记") });
    card.createEl("p", { text: file ? t("把这份资料分享给 agent，随后可以在最近动态中查看协作。") : t("打开一篇笔记后，就可以从这里直接分享。") });
    if (!file) return;
    const button = card.createEl("button", { cls: "mod-cta agentnote-current-share", text: t("分享当前笔记") });
    button.onclick = async () => {
      button.disabled = true;
      const shared = await this.plugin.shareFileFromPanel(file.path);
      if (shared) {
        button.setText(t("链接已复制 · 发给 Agent 即可"));
        button.addClass("is-complete");
      } else button.disabled = false;
      window.setTimeout(() => {
        if (!button.isConnected) return;
        button.setText(t("分享当前笔记"));
        button.removeClass("is-complete");
        button.disabled = false;
      }, 3500);
    };
  }
  private renderLoadError(parent: HTMLElement, title: string, error: unknown, canCheck = false): void {
    parent.addClass("agentnote-section");
    parent.setAttribute("role", "alert");
    parent.createEl("h4", { text: title });
    parent.createEl("p", { text: error instanceof Error ? error.message : String(error) });
    parent.createEl("p", { text: t("原数据已保留。请修复提示中的文件后重试。") });
    if (canCheck) parent.createEl("button", { text: t("检查并修复"), cls: "mod-cta" }).onclick = () => new DataRepairModal(this.app, this.plugin, () => this.refresh()).open();
    parent.createEl("button", { text: t("重新加载") }).onclick = () => void this.refresh();
  }
  private renderQuickStart(): void {
    const guide = this.contentEl.createDiv({ cls: "agentnote-quick-start" });
    const heading = guide.createDiv({ cls: "agentnote-section-heading" });
    const title = heading.createDiv(); title.createSpan({ cls: "agentnote-eyebrow", text: "FIRST WORKFLOW" }); title.createEl("h4", { text: t("第一次使用？三步开始") });
    const actions = heading.createDiv({ cls: "agentnote-quick-start-actions" });
    const open = actions.createEl("button", { text: t("查看教程"), cls: "mod-cta" });
    open.onclick = () => new QuickStartModal(this.app).open();
    const dismiss = actions.createEl("button", { text: "×", cls: "clickable-icon agentnote-quick-start-dismiss", attr: { "aria-label": t("隐藏快速教程"), title: t("隐藏教程") } });
    dismiss.onclick = async () => {
      this.plugin.settings.showQuickStart = false;
      await this.plugin.saveSettings();
      this.plugin.refreshPanels();
      new Notice(t("快速教程已隐藏；可在“设置 → agentNote → 帮助与更新”中重新打开。"), 5000);
    };
    const steps = guide.createDiv({ cls: "agentnote-quick-start-steps" });
    for (const [number, titleText, description] of [["01", t("接入一个 agent"), t("在下方选择已安装的 agent 并完成接入。")], ["02", t("分享一份资料"), t("右键文件或文件夹，复制 agentNote 地址。")], ["03", t("直接开始对话"), t("把地址发给 agent，或说“写到 Obsidian”。")]] as const) {
      const step = steps.createDiv({ cls: "agentnote-quick-start-step" }); step.createSpan({ text: number }); const copy = step.createDiv(); copy.createEl("strong", { text: titleText }); copy.createEl("small", { text: description });
    }
    renderMacOsReminder(guide);
  }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return t("创建「{0}」", event.title ?? t("未命名资料"));
    if (event.type === "node-updated") return t("更新「{0}」", event.title ?? t("未命名资料"));
    if (event.type === "node-archived") return t("归档「{0}」", event.title ?? t("未命名资料"));
    if (event.type === "node-restored") return t("恢复「{0}」", event.title ?? t("未命名资料"));
    if (event.type === "local-created") return t("新建「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "local-edited") return t("编辑「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "local-read") return t("本地阅读「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "local-moved") return t("整理「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "local-deleted") return t("删除「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "document-linked") return t("连接「{0}」", event.title ?? t("未命名文档"));
    if (event.type === "share-created") return t("分享「{0}」", event.title ?? t("资料"));
    return t("访问分享链接「{0}」", event.title ?? t("分享资料"));
  }
  private timeText(iso: string): string { return new Date(iso).toLocaleString(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private operationLabel(operation: LiveAgentActivity["operation"]): string {
    if (language() === "en") return { created: "created", updated: "updated", archived: "organized", read: "read" }[operation];
    if (operation === "created") return t("创建");
    if (operation === "updated") return t("更新");
    if (operation === "archived") return t("整理");
    return t("读取");
  }
  private liveActivityText(agentName: string, title: string, operations: LiveAgentActivity["operation"][]): string {
    if (agentName === t("分享链接")) return t("分享链接刚刚被访问「{0}」", title);
    return t("{0} 已{1}「{2}」", agentName, operations.map((operation) => this.operationLabel(operation)).join(t("并")), title);
  }
  private activityTargetKey(target: ActivityLinkTarget): string {
    if (target.nodeId) return `node:${target.nodeId}`;
    if (target.documentId) return `document:${target.documentId}`;
    if (target.shareId) return `share:${target.shareId}`;
    return target.path ? `path:${target.path}` : "";
  }
  private activitySurface(item: HTMLElement, target: ActivityLinkTarget, title: string): HTMLElement {
    const canOpen = target.type !== "local-deleted" && target.targetKind !== "folder" && target.targetKind !== "files" && !!this.activityTargetKey(target);
    if (!canOpen) return item.createDiv({ cls: "agentnote-activity-row" });
    const row = item.createEl("button", { cls: "agentnote-activity-row is-link", attr: { "aria-label": t("打开「{0}」", title) } });
    row.onclick = () => void this.openActivityTarget(target);
    return row;
  }
  private async openActivityTarget(target: ActivityLinkTarget): Promise<void> {
    try {
      const path = await this.plugin.store.activityFilePath(target);
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (!(file instanceof TFile)) throw new Error(t("原文件已不存在或不是文件"));
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (error) { new Notice(t("无法打开资料：{0}", (error as Error).message)); }
  }
  private updateRecentActivityVisibility(): void {
    const list = this.recentActivityList;
    const toggle = this.recentActivityToggle;
    if (!list || !toggle) return;
    toggle.hidden = list.children.length <= 3;
    toggle.setAttribute("aria-expanded", String(this.recentActivityExpanded));
    toggle.setText(this.recentActivityExpanded ? t("收起") : t("展开最近 {0} 条", list.children.length));
    for (const [index, item] of Array.from(list.children).entries()) (item as HTMLElement).hidden = !this.recentActivityExpanded && index >= 3;
  }
  showAgentActivity(activity: LiveAgentActivity): void {
    const container = this.recentActivityContainer;
    if (!container) return;
    if (this.recentActivityEmpty) { this.recentActivityEmpty.remove(); this.recentActivityEmpty = null; }
    const list = this.recentActivityList ?? container.createEl("ul", { cls: "agentnote-activity-list" });
    this.recentActivityList = list;
    const now = Date.now();
    const pending = this.pendingAgentActivity;
    const targetKey = this.activityTargetKey(activity);
    if (pending && pending.agentName === activity.agentName && pending.title === activity.title && pending.targetKey === targetKey && now - pending.receivedAt < 6_000) {
      if (!pending.operations.includes(activity.operation)) pending.operations.push(activity.operation);
      pending.copy.setText(this.liveActivityText(activity.agentName, activity.title, pending.operations));
      pending.time.setText(t("刚刚"));
      pending.receivedAt = now;
      pending.surface.addClass("is-new");
      window.setTimeout(() => pending.surface.removeClass("is-new"), 3_000);
      return;
    }
    const item = list.createEl("li");
    const surface = this.activitySurface(item, activity, activity.title);
    surface.addClass("is-new");
    agentAvatar(surface, this.agentConnections, activity.agentName, activity.operation === "read" ? "sparkles" : "file-text");
    const copy = surface.createSpan({ text: this.liveActivityText(activity.agentName, activity.title, [activity.operation]) });
    const time = surface.createEl("time", { text: t("刚刚") });
    list.prepend(item);
    while (list.children.length > 10) list.lastElementChild?.remove();
    this.updateRecentActivityVisibility();
    this.pendingAgentActivity = { surface, copy, time, agentName: activity.agentName, title: activity.title, targetKey, operations: [activity.operation], receivedAt: now };
    window.setTimeout(() => surface.removeClass("is-new"), 3_000);
    window.setTimeout(() => { if (time.isConnected) time.setText(this.timeText(activity.at)); }, 3_500);
  }
  private renderDashboard(insights: DashboardInsights, parent = this.contentEl, activityParent = parent): void {
    this.recentActivityContainer = null;
    this.recentActivityList = null;
    this.recentActivityEmpty = null;
    this.recentActivityToggle = null;
    this.pendingAgentActivity = null;
    const dashboard = parent.createDiv({ cls: "agentnote-dashboard" });
    if (!insights.health.complete) dashboard.createEl("p", { cls: "agentnote-health-notice", text: t("部分历史暂时不可用，已保留原文件：{0}", insights.health.issues.join("；")), attr: { role: "status" } });
    const overview = dashboard.createDiv({ cls: "agentnote-dashboard-hero" });
    const heroHeading = overview.createDiv({ cls: "agentnote-hero-heading" });
    const heroCopy = heroHeading.createDiv();
    heroCopy.createSpan({ cls: "agentnote-eyebrow", text: t("本地知识洞察") });
    heroCopy.createEl("h4", { text: t("知识正在进入工作流") });
    heroHeading.createEl("button", { cls: "agentnote-profile-link", text: t("完整档案") }).onclick = () => new InsightsModal(this.app, this.plugin).open();
    overview.createEl("p", { text: insights.summary.weekActivityCount ? t("本周 {0} 次知识活动，{1} 次资料使用。", insights.summary.weekActivityCount, insights.summary.weekResolves) : t("创建、维护、使用或整理资料后，这里会留下完整的知识活动。") });
    const stats = overview.createDiv({ cls: "agentnote-metric-strip" });
    for (const [value, label] of [[insights.summary.weekActivityCount, t("本周活动次数")], [insights.summary.weekUpdated, t("本周更新")], [insights.summary.weekResolves, t("本周复用")]] as const) {
      const stat = stats.createEl("button", { cls: "agentnote-metric" }); stat.createEl("strong", { text: String(value) }); stat.createSpan({ text: label });
      stat.onclick = () => new InsightsModal(this.app, this.plugin, label === t("本周复用") ? "month" : "overview").open();
    }
    const trend = overview.createDiv({ cls: "agentnote-panel-week" });
    const max = Math.max(1, ...insights.weeklyTrend.map((point) => point.count));
    for (const point of insights.weeklyTrend) {
      const day = trend.createDiv({ cls: "agentnote-panel-week-day" });
      const bar = day.createSpan({ cls: point.count ? "is-active" : "" });
      if (point.count) bar.setCssProps({ "--agentnote-week-opacity": String(0.3 + point.count / max * 0.7) });
      day.createSpan({ text: point.label });
      day.createSpan({ cls: "agentnote-visually-hidden", text: t("{0}：{1} 次活动", point.label, point.count) });
    }
    const activity = activityParent.createDiv({ cls: "agentnote-home-activity" });
    this.recentActivityContainer = activity;
    const heading = activity.createDiv({ cls: "agentnote-section-heading" });
    heading.createEl("h4", { text: t("最近动态") });
    const detail = heading.createEl("button", { text: t("全部记录"), cls: "agentnote-profile-link" });
    detail.onclick = () => new InsightsModal(this.app, this.plugin, "timeline").open();
    const list = activity.createEl("ul", { cls: "agentnote-activity-list" });
    this.recentActivityList = list;
    for (const event of insights.activities.slice(0, 10)) {
      const item = list.createEl("li");
      const row = this.activitySurface(item, event, event.title ?? t("资料"));
      const actor = event.actor?.name ?? event.actor?.id;
      if (actor) agentAvatar(row, this.agentConnections, actor, event.type === "share-resolved" ? "sparkles" : "file-text");
      else setIcon(row.createSpan({ cls: "agentnote-activity-icon" }), event.type === "share-resolved" ? "sparkles" : "file-text");
      row.createSpan({ text: this.activityText(event) });
      row.createEl("time", { text: this.timeText(event.at) });
    }
    if (!insights.activities.length) this.recentActivityEmpty = activity.createEl("p", { cls: "agentnote-empty-copy", text: t("创建并分享资料给 agent 后，这里会留下它进入工作流的记录。") });
    const toggle = activity.createEl("button", { cls: "agentnote-activity-toggle", attr: { type: "button" } });
    this.recentActivityToggle = toggle;
    toggle.onclick = () => { this.recentActivityExpanded = !this.recentActivityExpanded; this.updateRecentActivityVisibility(); };
    this.updateRecentActivityVisibility();
  }
  private renderServer(): void {
    const section = this.contentEl.createDiv({ cls: "agentnote-section agentnote-service-section" });
    section.createEl("h4", { text: t("本地服务") });
    const running = !!this.plugin.server?.port;
    const portInUse = !running && this.plugin.serverPortInUse;
    const port = this.plugin.server?.port ?? this.plugin.settings.port;
    const status = section.createDiv({ cls: `agentnote-service-status${running ? " is-running" : ""}`, attr: { role: "status", "aria-live": "polite" } });
    status.createSpan({ cls: "agentnote-service-indicator", attr: { "aria-hidden": "true" } });
    const copy = status.createDiv();
    copy.createEl("strong", { text: running ? t("服务正在运行") : portInUse ? t("端口已被占用") : t("服务未运行") });
    copy.createSpan({ text: running ? t("agent 可以读取分享和写入笔记") : t("启动后，agent 才能读取分享和写入笔记") });
    if (running) status.createEl("code", { text: `127.0.0.1:${port}`, attr: { "aria-label": t("本地服务地址 127.0.0.1:{0}", port) } });
    const button = section.createEl("button", { text: running ? t("停止服务") : portInUse ? t("重试启动") : t("启动服务"), cls: running ? "mod-warning" : "mod-cta" });
    button.onclick = () => void (this.plugin.server ? this.plugin.stopServer() : this.plugin.startServer());
    if (portInUse) section.createEl("p", { cls: "agentnote-service-conflict", text: t("若另一个仓库正在分享，请先到那个仓库的接入台停止服务，再回来重试。") });
  }
  private renderAgents(connections: AgentConnection[], parent = this.contentEl, unavailable?: string): void {
    const section = parent.createDiv({ cls: "agentnote-section agentnote-agents-section" });
    const heading = section.createDiv({ cls: "agentnote-section-heading" });
    heading.createEl("h4", { text: t("已接入 Agent") });
    heading.createSpan({ text: t("{0} 位", connections.filter((connection) => existsSync(connection.skillPath)).length) });
    const presetNames = new Set(KNOWN_AGENTS.map((agent) => agentNameKey(agent.name)));
    const entries = [
      ...KNOWN_AGENTS.map((agent) => ({ name: agent.name, id: agent.id, connection: connections.find((item) => agentNameKey(item.name) === agentNameKey(agent.name)) })),
      ...connections.filter((item) => !presetNames.has(agentNameKey(item.name))).map((item) => ({ name: item.name, id: "", connection: item })),
    ];
    const list = section.createDiv({ cls: "agentnote-agent-list" });
    for (const agent of entries) {
      const card = list.createDiv({ cls: "agentnote-agent-row" });
      if (agent.connection?.icon || agent.id) {
        const icon = card.createEl("img", { cls: "agentnote-agent-icon", attr: { src: agent.connection?.icon ?? AGENT_ICONS[agent.id], alt: t("{0} 图标", agent.name) } });
        icon.decoding = "async";
      } else setIcon(card.createSpan({ cls: "agentnote-agent-icon" }), "bot");
      const identity = card.createDiv({ cls: "agentnote-agent-identity" });
      identity.createEl("strong", { text: agent.name });
      const available = !!agent.connection && existsSync(agent.connection.skillPath);
      identity.createDiv({ cls: `agentnote-agent-status${available ? " is-connected" : ""}`, text: available ? t("已接入 · {0}", this.timeText(agent.connection!.connectedAt)) : unavailable ?? (agent.connection ? t("本机文件不可用") : t("未接入")) });
      if (!agent.connection) {
        card.createEl("button", { cls: "agentnote-agent-row-action", text: t("接入") }).onclick = () => this.copyInstallTask();
      } else {
        const more = card.createEl("button", { cls: "clickable-icon agentnote-agent-more", attr: { "aria-label": t("管理 {0}", agent.name) } });
        setIcon(more, "ellipsis");
        more.onclick = (event) => {
          const menu = new Menu();
          if (available) {
            menu.addItem((item) => item.setTitle(t("修改提示词")).setIcon("file-text").onClick(() => new AgentPromptModal(this.app, this.plugin, agent.connection!, () => this.refresh()).open()));
          } else menu.addItem((item) => item.setTitle(t("重新接入")).setIcon("plus").onClick(() => this.copyInstallTask()));
          menu.addSeparator();
          menu.addItem((item) => item.setTitle(t("删除")).setIcon("trash").setWarning(true).onClick(() => new RemoveAgentModal(this.app, this.plugin, agent.connection!, () => this.refresh()).open()));
          menu.showAtMouseEvent(event);
        };
      }
    }
    const manual = section.createEl("button", { cls: "agentnote-add-agent", text: t("＋ 接入其他 Agent") });
    manual.onclick = () => this.copyInstallTask();
    this.renderFooter(section);
  }
  private copyInstallTask(): void {
    new ManualInstallModal(this.app, this.plugin).open();
  }
  private renderFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: "agentnote-panel-footer" });
    footer.createEl("small", { text: t("作者 Evan") });
    footer.createSpan({ text: "·", attr: { "aria-hidden": "true" } });
    const feedback = footer.createEl("button", { text: t("反馈"), cls: "agentnote-feedback-link" });
    feedback.onclick = () => new FeedbackModal(this.app, this.plugin).open();
  }
}

export class QuickStartModal extends Modal {
  private stopDemo: (() => void) | null = null;
  onOpen(): void {
    this.modalEl.addClass("agentnote-quick-start-modal");
    this.contentEl.empty();
    this.contentEl.createSpan({ cls: "agentnote-eyebrow", text: "AGENTNOTE · QUICK START" });
    this.contentEl.createEl("h2", { text: t("三分钟开始使用") });
    this.contentEl.createEl("p", { text: t("完成一次接入、一次分享和一次对话，你就已经掌握 agentNote 的核心流程。") });
    const introduction = this.contentEl.createDiv({ cls: "agentnote-guide-introduction" });
    introduction.createSpan({ text: t("想先了解产品全貌？") });
    introduction.createEl("a", { text: t("浏览产品介绍"), cls: "external-link", attr: { href: "https://agentnote-intro.app.workbuddy.host/", target: "_blank", rel: "noopener noreferrer" } });
    renderMacOsReminder(this.contentEl);
    this.stopDemo = renderWorkflowDemo(this.contentEl);
    const steps = this.contentEl.createEl("ol", { cls: "agentnote-guide-steps" });
    for (const [title, description] of [[t("确认本地服务"), t("在接入台确认绿色状态灯和“服务正在运行”。服务只在本机 127.0.0.1 上提供内容。")], [t("接入一个 agent"), t("点击目标 Agent 的“接入”，查看并复制安装任务。Agent 安装并上报后，可在接入台核对状态。")], [t("分享并开始工作"), t("右键文件或文件夹选择“agentNote: 分享给 agent”。把复制的地址发送给 agent，并说明要它总结、审阅、计划或更新什么。")]] as const) {
      const item = steps.createEl("li"); item.createEl("strong", { text: title }); item.createEl("p", { text: description });
    }
    const example = this.contentEl.createDiv({ cls: "agentnote-guide-example" }); example.createEl("strong", { text: t("可直接发送给 agent") }); example.createEl("code", { text: t("请读取这个资料，整理重点、待办和风险：<粘贴 agentNote 地址>") });
    const help = this.contentEl.createDiv({ cls: "agentnote-guide-help" }); help.createSpan({ text: t("需要完整图文说明？") }); help.createEl("a", { text: t("打开 How to Use guide"), cls: "external-link", attr: { href: language() === "zh" ? "https://github.com/xinxinrana/agentNote-Obsidian-/blob/main/docs/如何使用.md" : "https://github.com/xinxinrana/agentNote-Obsidian-/blob/main/docs/How%20to%20Use.md", target: "_blank", rel: "noopener noreferrer" } });
  }
  onClose(): void { this.stopDemo?.(); this.stopDemo = null; }
}

type InsightTab = "overview" | "month" | "agents" | "timeline" | "archive";
type TimelineFilter = "all" | "construction" | "reuse" | "connection" | "organization";

class InsightsModal extends Modal {
  private tab: InsightTab = "overview";
  private timelineFilter: TimelineFilter = "all";
  private timelineDay: string | null = null;
  private selectedDay: string | null = null;
  private timelineAgent = "";
  private timelineQuery = "";
  private timelineLimit = 100;
  private renderSequence = 0;
  private bulkUndoIds: string[] | null = null;
  private localArchiveUndo: { originalPath: string; archivedPath: string } | null = null;
  private privateView = false;
  private agentConnections: AgentConnection[] = [];
  constructor(app: App, private plugin: AgentNotePlugin, initialTab: InsightTab = "overview") { super(app); this.tab = initialTab; }
  onOpen(): void { this.modalEl.addClass("agentnote-insights-modal"); void this.render(); }
  private timeText(iso: string): string { return new Date(iso).toLocaleString(locale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private dateText(iso: string): string { return new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" }); }
  private dayKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  private displayTitle(title: string): string { return this.privateView ? t("已匿名资料") : title; }
  private fileTitle(parent: HTMLElement, title: string, path: () => Promise<string | null>): void {
    if (this.privateView) { parent.createEl("strong", { text: this.displayTitle(title) }); return; }
    const button = parent.createEl("button", { cls: "agentnote-file-link", text: title, attr: { title: t("打开「{0}」", title) } });
    button.onclick = () => void (async () => {
      try {
        const filePath = await path();
        const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
        if (!(file instanceof TFile)) throw new Error(t("文件已不存在"));
        await this.app.workspace.getLeaf("tab").openFile(file);
        this.close();
      } catch (error) { new Notice(t("无法打开资料：{0}", (error as Error).message)); }
    })();
  }
  private weekDayKey(index: number): string {
    const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - ((day.getDay() + 6) % 7) + index);
    return this.dayKey(day);
  }
  private renderDayRecords(parent: HTMLElement, events: InsightEvent[]): HTMLElement {
    const section = parent.createDiv({ cls: "agentnote-detail-section agentnote-day-records" });
    const heading = section.createDiv({ cls: "agentnote-section-heading" });
    heading.createEl("h3", { text: t("{0} · 关联活动", this.selectedDay!) });
    heading.createEl("button", { text: t("清除日期") }).onclick = () => { this.selectedDay = null; void this.render(); };
    const selected = events.filter((event) => this.dayKey(new Date(event.at)) === this.selectedDay);
    if (!selected.length) section.createEl("p", { text: t("当日没有活动") });
    for (const event of selected) {
      const row = section.createDiv({ cls: "agentnote-day-record" });
      const actor = event.actor?.name ?? event.actor?.id;
      if (actor && !this.privateView) agentAvatar(row, this.agentConnections, actor, "file-text");
      if (event.type === "local-deleted" || event.targetKind === "folder" || event.targetKind === "files") row.createEl("strong", { text: this.activityText(event) });
      else this.fileTitle(row, this.activityText(event), () => this.plugin.store.activityFilePath(event));
      row.createEl("small", { text: this.timeText(event.at) });
    }
    return section;
  }
  private activeDays(trend: { count: number }[]): number { return trend.filter((point) => point.count > 0).length; }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return t("创建「{0}」", this.displayTitle(event.title ?? t("未命名资料")));
    if (event.type === "node-updated") return t("更新「{0}」", this.displayTitle(event.title ?? t("未命名资料")));
    if (event.type === "node-archived") return t("归档「{0}」", this.displayTitle(event.title ?? t("未命名资料")));
    if (event.type === "node-restored") return t("恢复「{0}」", this.displayTitle(event.title ?? t("未命名资料")));
    if (event.type === "local-created") return t("新建「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "local-edited") return t("编辑「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "local-read") return t("本地阅读「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "local-moved") return t("整理「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "local-deleted") return t("删除「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "document-linked") return t("连接「{0}」", this.displayTitle(event.title ?? t("未命名文档")));
    if (event.type === "share-created") return t("分享「{0}」", this.displayTitle(event.title ?? t("资料")));
    return t("访问分享链接「{0}」", this.displayTitle(event.title ?? t("分享资料")));
  }
  private async render(): Promise<void> {
    const previousScroll = this.contentEl.querySelector<HTMLElement>(".agentnote-modal-body")?.scrollTop ?? 0;
    const sequence = ++this.renderSequence;
    const insights = await this.plugin.store.getDashboardInsights();
    const agents = await this.plugin.store.getAgentInsights();
    const deletionVisibleAfter = new Date(); deletionVisibleAfter.setDate(deletionVisibleAfter.getDate() - 30);
    const events = (await this.plugin.store.listActivity()).filter((event) => event.type !== "local-deleted" || new Date(event.at) >= deletionVisibleAfter);
    try { this.agentConnections = await this.plugin.connectedAgents(); }
    catch { this.agentConnections = []; }
    if (sequence !== this.renderSequence) return;
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "agentnote-modal-header" });
    const title = header.createDiv(); title.createSpan({ cls: "agentnote-eyebrow", text: "AGENTNOTE · LOCAL PROFILE" }); title.createEl("h2", { text: t("我的知识工作档案"), attr: { id: "agentnote-profile-title" } });
    title.createEl("p", { text: t("把本地资料真正投入工作流，并留下可回看的成果。") });
    const actions = header.createDiv({ cls: "agentnote-profile-actions" });
    const privacy = actions.createEl("button", { text: this.privateView ? t("退出隐私展示") : t("隐私展示") });
    privacy.onclick = () => { this.privateView = !this.privateView; this.timelineQuery = ""; void this.render(); };
    const share = actions.createEl("button", { text: t("生成分享图"), cls: "mod-cta" });
    share.disabled = !insights.health.complete;
    if (share.disabled) share.setAttribute("title", t("历史不完整时暂不能生成分享图"));
    share.onclick = () => new InsightShareModal(this.app, insights, this.privateView).open();
    const tabs = this.contentEl.createDiv({ cls: "agentnote-insight-tabs", attr: { role: "tablist", "aria-labelledby": "agentnote-profile-title" } });
    for (const [tab, label] of [["overview", t("档案")], ["month", t("累计")], ["agents", "Agent"], ["timeline", t("时间线")], ["archive", t("整理")]] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.tab === tab ? "is-active" : "", attr: { role: "tab", "aria-selected": String(this.tab === tab), "aria-controls": "agentnote-insight-panel", id: `agentnote-insight-tab-${tab}` } });
      button.tabIndex = this.tab === tab ? 0 : -1;
      const select = (next: InsightTab) => { this.tab = next; this.selectedDay = null; void this.render().then(() => this.contentEl.querySelector<HTMLElement>(`#agentnote-insight-tab-${next}`)?.focus()); };
      button.onclick = () => select(tab);
      button.onkeydown = (event) => {
        const order: InsightTab[] = ["overview", "month", "agents", "timeline", "archive"];
        const index = order.indexOf(tab);
        const next = event.key === "ArrowRight" ? order[(index + 1) % order.length] : event.key === "ArrowLeft" ? order[(index + order.length - 1) % order.length] : event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1) : undefined;
        if (next) { event.preventDefault(); select(next); }
      };
    }
    const body = this.contentEl.createDiv({ cls: "agentnote-modal-body", attr: { role: "tabpanel", id: "agentnote-insight-panel", "aria-labelledby": `agentnote-insight-tab-${this.tab}` } });
    if (!insights.health.complete) body.createEl("p", { cls: "agentnote-health-notice", text: t("部分历史暂时不可用，已保留原文件：{0}", insights.health.issues.join("；")), attr: { role: "status" } });
    if (this.tab === "overview") {
      this.renderOverview(body, insights, agents);
      this.renderDocumentContributions(body, insights.weeklyDocuments, t("本周文档贡献"));
    }
    if (this.tab === "month") {
      this.renderPeriod(body, { eyebrow: "ALL-TIME CONTRIBUTIONS", title: t("开始以来的知识贡献"), description: t("从 {0} 的第一条记录开始。次数保留全部历史，记录墙展示最近 40 周。", this.dateText(insights.startedAt)), trendTitle: t("最近 40 周知识贡献"), rankingTitle: t("开始以来协作资料") }, [[insights.allTimeTrend.filter((point) => point.count > 0).length, t("近 40 周活跃天数")], [insights.summary.allTimeActivityCount, t("累计活动次数")], [insights.documents.reduce((total, entry) => total + entry.reuse, 0), t("累计分享与使用")], [insights.documents.length, t("参与资料")]], insights.allTime, insights.allTimeTrend);
      this.renderDocumentContributions(body, insights.documents, t("文档贡献档案"));
    }
    if (this.tab === "agents") this.renderAgents(body, agents);
    if (this.tab === "timeline") {
      this.renderTimeline(body, insights, events);
    }
    if (this.tab === "archive") this.renderArchive(body, insights);
    if (this.selectedDay && ["overview", "month"].includes(this.tab)) {
      const records = this.renderDayRecords(body, events);
      body.querySelector(".agentnote-period-trend, .agentnote-profile-grid")?.after(records);
    }
    body.scrollTop = previousScroll;
  }
  private renderOverview(parent: HTMLElement, insights: DashboardInsights, agents: Awaited<ReturnType<AgentNotePlugin["store"]["getAgentInsights"]>>): void {
    const activeDays = this.activeDays(insights.weeklyTrend);
    const profile = parent.createDiv({ cls: "agentnote-profile-card" });
    const summary = profile.createDiv({ cls: "agentnote-profile-summary" });
    summary.createSpan({ cls: "agentnote-profile-label", text: t("本周成果") });
    const mascot = summary.createEl("img", { cls: "agentnote-profile-mascot", attr: { src: xiaojiWave, alt: "" } });
    mascot.setAttribute("aria-hidden", "true");
    summary.createEl("strong", { text: t("{0} 次知识活动", insights.summary.weekActivityCount) });
    summary.createEl("p", { text: insights.summary.weekActivityCount ? t("建设 {0} · 维护整理 {1} · 分享 {2} · 使用 {3}", insights.summary.weekCreated, insights.summary.weekUpdated, insights.summary.weekSharesCreated, insights.summary.weekResolves) : t("开始建设、使用或整理资料后，这里会记录完整的知识工作成果。") });
    const metrics = profile.createDiv({ cls: "agentnote-profile-metrics" });
    for (const [value, label] of [[insights.summary.weekUsedNotes, t("本周使用资料")], [activeDays, t("活跃天数")], [agents.length, t("协作 agent")]] as const) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createSpan({ text: label });
    }

    const grid = parent.createDiv({ cls: "agentnote-profile-grid" });
    const rhythm = grid.createDiv({ cls: "agentnote-profile-section" });
    const rhythmHeading = rhythm.createDiv({ cls: "agentnote-profile-section-heading" });
    rhythmHeading.createEl("h3", { text: t("本周工作节奏") });
    rhythmHeading.createSpan({ text: t("{0} / 7 天活跃", activeDays) });
    const days = rhythm.createDiv({ cls: "agentnote-profile-days" });
    const max = Math.max(1, ...insights.weeklyTrend.map((point) => point.count));
    for (const point of insights.weeklyTrend) {
      const key = this.weekDayKey(insights.weeklyTrend.indexOf(point));
      const day = days.createEl("button", { cls: `agentnote-profile-day${point.count ? " is-active" : ""}`, attr: { title: t("{0}：{1} 次活动", point.label, point.count), "aria-pressed": String(this.selectedDay === key) } });
      day.onclick = () => { this.selectedDay = this.selectedDay === key ? null : key; void this.render(); };
      if (point.count) day.setCssProps({ "--agentnote-activity-strength": `${Math.round((0.22 + point.count / max * 0.5) * 100)}%` });
      day.createEl("strong", { text: point.label }); day.createSpan({ text: String(point.count) });
    }

    const next = grid.createDiv({ cls: "agentnote-profile-section agentnote-profile-next" });
    next.createSpan({ cls: "agentnote-profile-label", text: t("下一步") });
    if (insights.archiveCandidates.length) {
      next.createEl("h3", { text: t("整理 {0} 条沉睡资料", insights.archiveCandidates.length) });
      next.createEl("p", { text: t("把暂未复用的旧资料归档，让下一次检索更轻快。") });
      const button = next.createEl("button", { text: t("查看整理建议") });
      button.onclick = () => { this.tab = "archive"; void this.render(); };
    } else {
      next.createEl("h3", { text: insights.summary.weekActivityCount ? t("继续积累可复用上下文") : t("分享第一条工作资料") });
      next.createEl("p", { text: insights.summary.weekActivityCount ? t("把高频资料固定下来，让每一次协作都从已有上下文开始。") : t("从文件菜单选择“分享给 agent”，让资料立即进入工作流。") });
    }

    const highlights = parent.createDiv({ cls: "agentnote-profile-highlights" });
    const heading = highlights.createDiv({ cls: "agentnote-profile-section-heading" });
    heading.createEl("h3", { text: t("本周协作资料") });
    heading.createSpan({ text: t("按实际使用次数排序") });
    if (!insights.weekly.length) highlights.createEl("p", { cls: "agentnote-empty-copy", text: t("本地查看或被 agent 使用后，资料会在这里形成协作记录。") });
    else {
      const cards = highlights.createDiv({ cls: "agentnote-profile-note-list" });
      for (const [index, entry] of insights.weekly.entries()) {
        const card = cards.createDiv({ cls: "agentnote-profile-note" });
        card.createSpan({ cls: "agentnote-profile-rank", text: String(index + 1).padStart(2, "0") });
        const detail = card.createDiv(); this.fileTitle(detail, entry.node.title, () => this.plugin.store.nodeFilePath(entry.node.id)); detail.createEl("small", { text: entry.reason });
        card.createSpan({ cls: "agentnote-profile-use-count", text: t("{0} 次", entry.reads) });
      }
    }
  }
  private renderTabHero(parent: HTMLElement, eyebrow: string, title: string, description: string, metricsData: readonly (readonly [number, string])[]): void {
    const hero = parent.createDiv({ cls: "agentnote-tab-hero" });
    const copy = hero.createDiv(); copy.createSpan({ cls: "agentnote-profile-label", text: eyebrow }); copy.createEl("h3", { text: title }); copy.createEl("p", { text: description });
    const metrics = hero.createDiv({ cls: "agentnote-tab-hero-metrics" });
    for (const [value, label] of metricsData) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createSpan({ text: label });
    }
  }
  private renderAgents(parent: HTMLElement, agents: Awaited<ReturnType<AgentNotePlugin["store"]["getAgentInsights"]>>): void {
    const uses = agents.reduce((total, agent) => total + agent.uses, 0);
    const writes = agents.reduce((total, agent) => total + agent.created + agent.updated, 0);
    this.renderTabHero(parent, "COLLABORATORS", t("Agent 协作网络"), agents.length ? t("每一次读取、创建和更新，都会留下可回看的本地协作轨迹。") : t("接入的 agent 开始调用后，这里会逐渐形成你的协作网络。"), [[agents.length, t("活跃 agent")], [uses, t("资料读取")], [writes, t("内容变更")]]);
    if (!agents.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: t("还没有协作记录。完成一次资料分享或写入后，再回来看看它如何参与工作。") }); return; }
    const list = parent.createDiv({ cls: "agentnote-agent-insights" });
    for (const agent of agents) {
      const card = list.createDiv({ cls: "agentnote-agent-insight" });
      const heading = card.createDiv({ cls: "agentnote-agent-insight-heading" });
      const who = heading.createDiv({ cls: "agentnote-agent-insight-who" });
      if (!this.privateView) agentAvatar(who, this.agentConnections, agent.name, "bot", "agentnote-agent-icon");
      who.createEl("strong", { text: this.privateView ? t("协作者") : agent.name }); heading.createSpan({ text: t("有协作记录") });
      const stats = card.createDiv({ cls: "agentnote-agent-insight-stats" });
      for (const [value, label] of [[agent.uses, t("读取资料")], [agent.created, t("新建内容")], [agent.updated, t("更新内容")]] as const) {
        const stat = stats.createDiv(); stat.createEl("strong", { text: String(value) }); stat.createSpan({ text: label });
      }
      card.createEl("small", { text: t("最近活动 · {0}", this.timeText(agent.lastActive)) });
      card.createEl("button", { text: t("查看活动记录") }).onclick = () => { this.timelineAgent = agent.name; this.timelineQuery = ""; this.timelineDay = null; this.timelineFilter = "all"; this.tab = "timeline"; void this.render(); };
    }
  }
  private renderPeriod(parent: HTMLElement, header: { eyebrow: string; title: string; description: string; trendTitle: string; rankingTitle: string }, metricsData: readonly (readonly [number, string])[], notes: InsightNote[], trend: { label: string; count: number }[]): void {
    this.renderTabHero(parent, header.eyebrow, header.title, header.description, metricsData);
    const trendSection = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-trend" });
    const trendHeading = trendSection.createDiv({ cls: "agentnote-section-heading" }); trendHeading.createEl("h3", { text: header.trendTitle });
    const max = Math.max(1, ...trend.map((point) => point.count));
    this.renderContributionGraph(trendSection, trend, max);
    const ranking = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
    const rankingHeading = ranking.createDiv({ cls: "agentnote-section-heading" }); rankingHeading.createEl("h3", { text: header.rankingTitle }); rankingHeading.createSpan({ text: t("按实际复用排序 · 保护后不参与归档建议") });
    if (!notes.length) ranking.createEl("p", { cls: "agentnote-empty-copy", text: t("这一周期还没有被读取的分享笔记。") });
    for (const [index, entry] of notes.entries()) {
      const card = ranking.createDiv({ cls: "agentnote-value-card" });
      card.createSpan({ cls: "agentnote-value-rank", text: String(index + 1).padStart(2, "0") });
      const row = card.createDiv({ cls: "agentnote-value-title" }); this.fileTitle(row, entry.node.title, () => this.plugin.store.nodeFilePath(entry.node.id));
      if (entry.node.pinned) row.createSpan({ cls: "agentnote-pin-badge", text: t("已保护"), attr: { title: t("这条资料不会出现在“整理”中的归档建议里。") } });
      card.createEl("p", { text: entry.reason });
      if (entry.lastRead) card.createEl("small", { text: t("最近使用：{0}", this.timeText(entry.lastRead)) });
      const pin = card.createEl("button", { text: entry.node.pinned ? t("取消保护") : t("保护不归档"), attr: { title: entry.node.pinned ? t("允许这条资料再次进入归档建议。") : t("保护后，这条资料不会出现在“整理”中的归档建议里；不会修改内容或分享地址。") } });
      pin.onclick = () => void (async () => { pin.disabled = true; const pinned = !entry.node.pinned; await this.plugin.store.updateNode(entry.node.id, { pinned }); new Notice(pinned ? t("已保护「{0}」：它不会进入归档建议。", entry.node.title) : t("已取消保护「{0}」。", entry.node.title)); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
  private renderDocumentContributions(parent: HTMLElement, documents: DashboardInsights["documents"], title: string): void {
    const section = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
    const heading = section.createDiv({ cls: "agentnote-section-heading" }); heading.createEl("h3", { text: title }); heading.createSpan({ text: t("每条活动计 1 次，可查看明细；次数不代表内容质量。") });
    if (!documents.length) { section.createEl("p", { cls: "agentnote-empty-copy", text: t("开始创建、使用或整理资料后，这里会形成可追溯的文档贡献档案。") }); return; }
    for (const [index, entry] of documents.slice(0, 8).entries()) {
      const card = section.createDiv({ cls: "agentnote-value-card" });
      card.createSpan({ cls: "agentnote-value-rank", text: String(index + 1).padStart(2, "0") });
      const row = card.createDiv({ cls: "agentnote-value-title" }); this.fileTitle(row, entry.document.title, async () => entry.document.path); row.createSpan({ cls: "agentnote-profile-use-count", text: t("{0} 次活动", entry.activityCount) });
      card.createEl("p", { text: t("内容建设 {0} 次 · 分享与使用 {1} 次 · 知识连接 {2} 次 · 知识整理 {3} 次", entry.construction, entry.reuse, entry.connection, entry.organization) });
      if (entry.lastActive) card.createEl("small", { text: t("最近活动：{0}{1}", this.timeText(entry.lastActive), title === t("文档贡献档案") ? t(" · 近 30 天 {0} 次活动", entry.recentActivityCount) : "") });
      card.createEl("button", { text: t("查看活动记录") }).onclick = () => {
        this.timelineQuery = entry.document.title;
        this.timelineAgent = "";
        this.timelineDay = null;
        this.timelineFilter = "all";
        this.timelineLimit = 100;
        this.selectedDay = null;
        this.tab = "timeline";
        const body = this.contentEl.querySelector<HTMLElement>(".agentnote-modal-body");
        if (body) body.scrollTop = 0;
        void this.render();
      };
    }
  }
  private renderContributionGraph(parent: HTMLElement, trend: { label: string; count: number }[], max: number): void {
    const min = Math.min(...trend.filter((point) => point.count > 0).map((point) => point.count));
    const firstDate = new Date(`${trend[0]?.label ?? "1970-01-01"}T00:00:00`);
    const leadingDays = firstDate.getDay();
    const weeks = Math.ceil((leadingDays + trend.length) / 7);
    const activeIndexes = trend.flatMap((point, index) => point.count ? [index] : []);
    const firstActiveColumn = Math.floor((leadingDays + (activeIndexes[0] ?? 0)) / 7);
    const lastActiveColumn = Math.floor((leadingDays + (activeIndexes.at(-1) ?? 0)) / 7);
    const activeColumnSpan = Math.max(1, lastActiveColumn - firstActiveColumn);
    const chart = parent.createDiv({ cls: "agentnote-contribution-chart" });
    window.requestAnimationFrame(() => { chart.scrollLeft = chart.scrollWidth; });
    const weekdays = chart.createDiv({ cls: "agentnote-contribution-weekdays" });
    for (const label of [t("日"), "", t("二"), "", t("四"), "", t("六")]) weekdays.createSpan({ text: label });
    const calendar = chart.createDiv({ cls: "agentnote-contribution-calendar" });
    calendar.setCssProps({ "--agentnote-contribution-weeks": String(weeks), "--agentnote-contribution-width": `${Math.max(13, weeks * 17 - 4)}px` });
    const months = calendar.createDiv({ cls: "agentnote-contribution-months" });
    const grid = calendar.createDiv({ cls: "agentnote-contribution-grid" });
    for (let index = 0; index < leadingDays; index++) grid.createSpan({ cls: "agentnote-contribution-cell is-empty", attr: { "aria-hidden": "true" } });
    let lastMonthColumn = -2;
    for (const [index, point] of trend.entries()) {
      const date = new Date(`${point.label}T00:00:00`);
      const column = Math.floor((leadingDays + index) / 7);
      if ((index === 0 || date.getDate() === 1) && column - lastMonthColumn >= 2) {
        const label = months.createSpan({ text: date.toLocaleDateString(locale(), { month: "short" }) });
        label.setCssProps({ "--agentnote-month-offset": `${column * 17}px` });
        lastMonthColumn = column;
      }
      const cell = grid.createEl("button", { cls: `agentnote-contribution-cell${point.count ? " is-active" : ""}`, attr: { "aria-label": t("{0}：{1} 次活动", point.label, point.count) } });
      cell.setAttribute("aria-pressed", String(this.selectedDay === point.label));
      cell.onclick = () => { this.selectedDay = this.selectedDay === point.label ? null : point.label; void this.render(); };
      if (point.count) cell.setCssProps({ ...contributionShade(point.count, min, max), "--agentnote-reveal-delay": `${Math.round(Math.pow((column - firstActiveColumn) / activeColumnSpan, 0.72) * 425 + date.getDay() * 2)}ms` });
    }
  }
  private renderTimeline(parent: HTMLElement, insights: DashboardInsights, events: InsightEvent[]): void {
    const agents = new Set(events.map((event) => event.actor?.name ?? event.actor?.id).filter(Boolean));
    this.renderTabHero(parent, "ACTIVITY LOG", t("协作时间线"), t("分享链接每次成功访问都会留下记录；本地阅读指文件在 Obsidian 中保持打开超过 20 秒。"), [[events.length, t("记录活动")], [agents.size, t("参与 agent")], [insights.summary.weekResolves, t("本周使用")]]);
    const search = parent.createDiv({ cls: "agentnote-timeline-search" });
    const query = search.createEl("input", { attr: { type: "search", placeholder: t("查找笔记名称"), "aria-label": t("查找笔记名称") } });
    query.value = this.privateView ? "" : this.timelineQuery;
    query.disabled = this.privateView;
    query.oninput = () => { const position = query.selectionStart; this.timelineQuery = query.value; void this.render().then(() => { const input = this.contentEl.querySelector<HTMLInputElement>(".agentnote-timeline-search input"); input?.focus(); input?.setSelectionRange(position, position); }); };
    const collaborator = search.createEl("select", { attr: { "aria-label": t("全部协作者") } });
    collaborator.createEl("option", { text: t("全部协作者"), value: "" });
    collaborator.createEl("option", { text: t("本地操作"), value: "__local" });
    for (const name of agents) collaborator.createEl("option", { text: this.privateView ? t("协作者 {0}", [...agents].indexOf(name) + 1) : name!, value: name });
    collaborator.value = this.timelineAgent;
    collaborator.onchange = () => { this.timelineAgent = collaborator.value; void this.render(); };
    const filters = parent.createDiv({ cls: "agentnote-timeline-filters" });
    if (this.timelineDay) filters.createEl("button", { cls: "agentnote-timeline-day", text: t("{0} · 清除日期", this.timelineDay) }).onclick = () => { this.timelineDay = null; void this.render(); };
    for (const [filter, label] of [["all", t("全部")], ["construction", t("建设")], ["reuse", t("使用")], ["connection", t("连接")], ["organization", t("整理")]] as const) {
      const button = filters.createEl("button", { text: label, cls: this.timelineFilter === filter ? "is-active" : "" });
      button.onclick = () => { this.timelineFilter = filter; void this.render(); };
    }
    const matching = events.filter((event) => (!this.timelineDay || this.dayKey(new Date(event.at)) === this.timelineDay) && (!this.timelineAgent || (this.timelineAgent === "__local" ? !event.actor && event.origin === "local" : (event.actor?.name ?? event.actor?.id) === this.timelineAgent)) && (!this.timelineQuery || (event.title ?? "").toLocaleLowerCase().includes(this.timelineQuery.toLocaleLowerCase())));
    const visible = matching.filter((event) => this.timelineFilter === "all" || (this.timelineFilter === "construction" && ["node-created", "node-updated", "local-created", "local-edited"].includes(event.type)) || (this.timelineFilter === "reuse" && ["share-created", "share-resolved", "local-read"].includes(event.type)) || (this.timelineFilter === "connection" && event.type === "document-linked") || (this.timelineFilter === "organization" && ["node-archived", "node-restored", "local-moved", "local-deleted"].includes(event.type)));
    if (!visible.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: t("还没有符合条件的活动。换一个筛选条件，或开始一次新的资料协作。") }); return; }
    search.createSpan({ text: t("{0} 条记录", visible.length) });
    const list = parent.createEl("ul", { cls: "agentnote-timeline" });
    let previousDay = "";
    for (const event of visible.slice(0, this.timelineLimit)) {
      const day = this.dayKey(new Date(event.at));
      if (day !== previousDay) { list.createEl("li", { cls: "agentnote-timeline-date", text: this.dateText(event.at) }); previousDay = day; }
      const item = list.createEl("li");
      const actor = event.actor?.name ?? event.actor?.id;
      if (actor && !this.privateView) agentAvatar(item, this.agentConnections, actor, event.type === "share-resolved" ? "sparkles" : "file-text");
      const detail = item.createDiv();
      const chip = event.type === "document-linked" ? t("连接") : ["share-resolved", "local-read"].includes(event.type) ? t("使用") : event.type === "share-created" ? t("分享") : ["node-created", "local-created"].includes(event.type) ? t("创建") : ["local-moved", "local-deleted", "node-archived", "node-restored"].includes(event.type) ? t("整理") : t("维护");
      const title = detail.createDiv({ cls: "agentnote-timeline-title" });
      const canOpen = !this.privateView && event.type !== "local-deleted" && event.targetKind !== "folder" && event.targetKind !== "files" && !!(event.nodeId || event.documentId || event.shareId || event.path);
      if (canOpen) this.fileTitle(title, this.activityText(event), () => this.plugin.store.activityFilePath(event));
      else title.createEl("strong", { text: this.activityText(event) });
      title.createSpan({ cls: `agentnote-event-chip is-${event.type}`, text: chip });
      detail.createSpan({ text: [this.privateView && event.actor ? t("协作者") : event.actor?.name ?? event.actor?.id ?? (event.type === "share-resolved" ? t("访问方未识别") : event.origin === "local" ? t("本地操作") : t("未申报 agent")), this.privateView ? undefined : event.actor?.sessionTitle, event.targetKind === "folder" ? t("文件夹") : event.targetKind === "files" ? t("多文件") : event.targetKind === "node" ? t("笔记") : event.targetKind === "file" ? t("文件") : undefined].filter(Boolean).join(" · ") });
      item.createEl("time", { text: this.timeText(event.at) });
    }
    if (visible.length > this.timelineLimit) parent.createEl("button", { text: t("再看 {0} 条", Math.min(100, visible.length - this.timelineLimit)) }).onclick = () => { this.timelineLimit += 100; void this.render(); };
  }
  private renderArchive(parent: HTMLElement, insights: DashboardInsights): void {
    if (!insights.health.complete) { parent.createEl("p", { cls: "agentnote-health-notice", text: t("历史尚不完整，整理建议暂不可用。"), attr: { role: "status" } }); return; }
    this.renderTabHero(parent, "KNOWLEDGE HYGIENE", t("资料整理建议"), insights.archiveCandidates.length ? t("这里只给出可解释的建议，是否保留或归档始终由你决定。") : t("目前没有需要优先整理的资料；被保护或近期使用的文档不会进入建议。"), [[insights.archiveCandidates.length, t("待整理资料")], [insights.summary.monthResolves, t("本月协作")], [insights.monthly.length, t("活跃资料")]]);
    const heading = parent.createDiv({ cls: "agentnote-section-heading agentnote-archive-heading" }); heading.createEl("h3", { text: insights.archiveCandidates.length ? t("建议处理的资料") : t("整理状态良好") });
    const nodeCandidates = insights.archiveCandidates.filter((candidate) => !!candidate.node);
    if (nodeCandidates.length) {
      const all = heading.createEl("button", { text: t("归档 {0} 条 agentNote 笔记", nodeCandidates.length), cls: "mod-warning" });
      all.onclick = () => {
        const confirm = new Modal(this.app);
        confirm.contentEl.createEl("h3", { text: t("确认批量归档？") });
        confirm.contentEl.createEl("p", { text: t("将移动 {0} 条 agentNote 笔记到归档目录；内容和分享地址都会保留，可立即撤销。", nodeCandidates.length) });
        const actions = confirm.contentEl.createDiv({ cls: "agentnote-node-actions" });
        actions.createEl("button", { text: t("再看看") }).onclick = () => confirm.close();
        const submit = actions.createEl("button", { text: t("确认归档"), cls: "mod-warning" });
        submit.onclick = () => void (async () => { submit.disabled = true; const ids = nodeCandidates.map((candidate) => candidate.node!.id); try { await this.plugin.store.archiveNodes(ids, true); this.bulkUndoIds = ids; confirm.close(); new Notice(t("已归档 {0} 条建议笔记。", ids.length)); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(t("归档失败：{0}", (error as Error).message)); submit.disabled = false; } })();
        confirm.open();
      };
    }
    if (this.bulkUndoIds?.length) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: t("刚刚归档了 {0} 条笔记。", this.bulkUndoIds.length) });
      const button = undo.createEl("button", { text: t("撤销") }); button.onclick = () => void (async () => { await this.plugin.store.archiveNodes(this.bulkUndoIds!, false); this.bulkUndoIds = null; await this.render(); this.plugin.refreshPanels(); })();
    }
    if (this.localArchiveUndo) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: t("刚刚归档了 vault 文档。") });
      const button = undo.createEl("button", { text: t("撤销") }); button.onclick = () => void (async () => { const previous = this.localArchiveUndo!; try { await this.plugin.moveVaultDocument(previous.archivedPath, previous.originalPath); this.localArchiveUndo = null; await this.render(); } catch (error) { new Notice(t("恢复失败：{0}", (error as Error).message)); } })();
    }
    if (!insights.archiveCandidates.length) parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: t("没有需要优先整理的资料。") });
    const list = parent.createDiv({ cls: "agentnote-archive-list" });
    for (const { node, document, reason, uses, lastUsed } of insights.archiveCandidates) {
      const card = list.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, document.title, async () => node ? this.plugin.store.nodeFilePath(node.id) : document.path); card.createSpan({ text: reason });
      if (uses) card.createEl("small", { text: t("累计使用 {0} 次{1}", uses, lastUsed ? t(" · 最近使用 {0}", this.dateText(lastUsed)) : "") });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const keep = actions.createEl("button", { text: t("保护，不归档"), attr: { title: t("尊重你的判断；保护后不会再推荐归档。") } }); keep.onclick = () => void (async () => { try { if (node) await this.plugin.store.updateNode(node.id, { pinned: true }); else await this.plugin.store.protectDocument(document.id, true); new Notice(t("已保护「{0}」：它不会进入归档建议。", document.title)); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(t("保护失败：{0}", (error as Error).message)); } })();
      const archive = actions.createEl("button", { text: t("归档"), cls: "mod-warning", attr: { title: node ? t("移入 agentNote 归档目录，可撤销") : t("移入 agentNote/归档文件，保留分享链接，可撤销") } }); archive.onclick = () => void (async () => { archive.disabled = true; try { if (node) await this.plugin.store.archiveNode(node.id, true); else this.localArchiveUndo = { originalPath: document.path, archivedPath: await this.plugin.archiveVaultDocument(document.path) }; await this.render(); this.plugin.refreshPanels(); } catch (error) { archive.disabled = false; new Notice(t("归档失败：{0}", (error as Error).message)); } })();
    }
    const protectedDocuments = insights.protectedDocuments.filter((candidate) => !candidate.path.startsWith("agentNote/nodes/"));
    if (insights.protectedNodes.length || protectedDocuments.length) {
      const protectedSection = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
      protectedSection.createEl("h3", { text: t("你决定保留的资料") });
      protectedSection.createEl("p", { text: t("这些资料不会进入自动整理建议；需要时可以取消保护。") });
      const protectedList = protectedSection.createDiv({ cls: "agentnote-archive-list" });
      for (const node of insights.protectedNodes) {
        const card = protectedList.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, node.title, () => this.plugin.store.nodeFilePath(node.id));
        const button = card.createEl("button", { text: t("取消保护") }); button.onclick = () => void (async () => { await this.plugin.store.updateNode(node.id, { pinned: false }); await this.render(); this.plugin.refreshPanels(); })();
      }
      for (const document of protectedDocuments) {
        const card = protectedList.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, document.title, async () => document.path);
        const button = card.createEl("button", { text: t("取消保护") }); button.onclick = () => void (async () => { await this.plugin.store.protectDocument(document.id, false); await this.render(); this.plugin.refreshPanels(); })();
      }
    }
  }
}

class InsightShareModal extends Modal {
  private imageBlob: Blob | null = null;
  private imageUrl: string | null = null;
  constructor(app: App, private insights: DashboardInsights, private privateView: boolean) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-share-modal"); void this.render(); }
  onClose(): void { if (this.imageUrl) URL.revokeObjectURL(this.imageUrl); }
  private activeDays(): number { return this.insights.allTimeTrend.filter((point) => point.count > 0).length; }
  private titleForShare(): string { return this.privateView ? t("已匿名资料") : this.insights.allTime[0]?.node.title ?? this.insights.documents[0]?.document.title ?? t("等待第一条资料被使用"); }
  private renderShareCard(parent: HTMLElement): void {
    const activeDays = this.activeDays();
    const trend = this.insights.allTimeTrend;
    const max = Math.max(1, ...trend.map((point) => point.count));
    const min = Math.min(...trend.filter((point) => point.count > 0).map((point) => point.count));
    const start = new Date(this.insights.startedAt).toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric" });
    const brand = parent.createDiv({ cls: "agentnote-share-brand-row" });
    brand.createSpan({ cls: "agentnote-share-brand", text: "agentNote · Local knowledge profile" });
    brand.createEl("img", { cls: "agentnote-companion", attr: { src: xiaojiWave, alt: t("小记，agentNote 的笔记伙伴") } });
    parent.createEl("h2", { text: t("开始以来的知识贡献") });
    parent.createEl("p", { cls: "agentnote-share-subtitle", text: t("从 {0} 的第一条记录开始，持续积累可复用的本地资料。", start) });
    const metrics = parent.createDiv({ cls: "agentnote-share-metrics" });
    for (const [value, label] of [[this.insights.summary.allTimeActivityCount, t("累计活动次数")], [this.insights.documents.length, t("参与资料")], [activeDays, t("近 40 周活跃天数")]] as const) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createSpan({ text: label });
    }
    const contributions = parent.createDiv({ cls: "agentnote-share-contributions" });
    const heading = contributions.createDiv({ cls: "agentnote-share-contributions-heading" });
    heading.createEl("strong", { text: t("最近 40 周知识贡献") });
    heading.createSpan({ text: t("{0} 天有知识活动", activeDays) });
    const chart = contributions.createDiv({ cls: "agentnote-share-contribution-chart" });
    const weekdays = chart.createDiv({ cls: "agentnote-share-contribution-weekdays" });
    for (const label of [t("日"), "", t("二"), "", t("四"), "", t("六")]) weekdays.createSpan({ text: label });
    const calendar = chart.createDiv({ cls: "agentnote-share-contribution-calendar" });
    const months = calendar.createDiv({ cls: "agentnote-share-contribution-months" });
    const grid = calendar.createDiv({ cls: "agentnote-share-contribution-grid" });
    const leadingDays = new Date(`${trend[0]?.label ?? "1970-01-01"}T00:00:00`).getDay();
    for (let index = 0; index < leadingDays; index++) grid.createSpan({ cls: "agentnote-share-contribution-cell is-empty" });
    let lastMonthColumn = -2;
    for (const [index, point] of trend.entries()) {
      const date = new Date(`${point.label}T00:00:00`);
      const column = Math.floor((leadingDays + index) / 7);
      if ((index === 0 || date.getDate() === 1) && column - lastMonthColumn >= 2) {
        months.createSpan({ text: date.toLocaleDateString(locale(), { month: "short" }) }).setCssProps({ "--agentnote-share-month-offset": `${column * 14}px` });
        lastMonthColumn = column;
      }
      const cell = grid.createSpan({ cls: `agentnote-share-contribution-cell${point.count ? " is-active" : ""}`, attr: { title: t("{0}：{1} 次活动", point.label, point.count) } });
      if (point.count) cell.setCssProps(contributionShade(point.count, min, max));
    }
    const top = parent.createDiv({ cls: "agentnote-share-top-note" });
    top.createSpan({ text: t("开始以来的协作资料") });
    top.createEl("strong", { text: this.titleForShare() });
    top.createEl("small", { text: this.insights.allTime[0] ? t("累计被读取 {0} 次", this.insights.allTime[0].reads) : this.insights.documents[0] ? t("累计 {0} 次活动", this.insights.documents[0].activityCount) : t("从一次分享开始建立可复用上下文") });
    parent.createEl("small", { cls: "agentnote-share-footer", text: t("由 agentNote 在本地生成 · 内容不离开你的 vault") });
  }
  private async render(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("分享图预览") });
    this.contentEl.createEl("p", { text: t("确认预览后，点击按钮即可将 PNG 图片复制到剪贴板。") });
    const preview = this.contentEl.createDiv({ cls: "agentnote-share-preview" });
    const card = preview.createDiv({ cls: "agentnote-share-card" });
    this.renderShareCard(card);
    const actions = this.contentEl.createDiv({ cls: "agentnote-share-actions" });
    const copy = actions.createEl("button", { text: t("正在生成分享图…"), cls: "mod-cta" });
    copy.disabled = true;
    actions.createEl("button", { text: t("关闭") }).onclick = () => this.close();
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const blob = await toBlob(card, { cacheBust: true, pixelRatio: 2 });
      if (!blob) throw new Error(t("未生成图片"));
      this.imageBlob = blob;
      this.imageUrl = URL.createObjectURL(blob);
      preview.empty();
      preview.createEl("img", { cls: "agentnote-share-image", attr: { src: this.imageUrl, alt: t("知识工作档案分享图预览") } });
      copy.setText(t("复制图片到剪贴板"));
      copy.disabled = false;
      copy.onclick = () => void this.copyImage();
    } catch (error) {
      copy.setText(t("分享图生成失败"));
      new Notice(t("分享图生成失败：{0}", (error as Error).message));
    }
  }
  private async copyImage(): Promise<void> {
    if (!this.imageBlob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": this.imageBlob })]);
      new Notice(t("分享图已复制到剪贴板，可直接粘贴发送。"));
    } catch {
      new Notice(t("复制图片失败，请确认 Obsidian 已获得系统剪贴板权限。"));
    }
  }
}

export class BulkActivityModal extends Modal {
  private remember = false;
  private decided = false;
  constructor(app: App, private count: number, private done: (record: boolean, remember: boolean) => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("检测到大量文件变动") });
    this.contentEl.createEl("p", { text: t("短时间内检测到 {0} 次本地操作。可能是 Git 同步或批量整理，要把它们计入知识活动吗？", this.count) });
    new Setting(this.contentEl).setName(t("记住这次选择，以后不再提示")).addToggle((toggle) => toggle.onChange((value) => { this.remember = value; }));
    const actions = this.contentEl.createDiv({ cls: "agentnote-bulk-actions" });
    actions.createEl("button", { text: t("不计入活动（推荐）"), cls: "mod-cta" }).onclick = () => this.choose(false);
    actions.createEl("button", { text: t("计入活动") }).onclick = () => this.choose(true);
  }
  onClose(): void { if (!this.decided) this.choose(false, false); }
  private choose(record: boolean, remember = this.remember): void {
    if (this.decided) return;
    this.decided = true;
    this.done(record, remember);
    this.close();
  }
}

class RemoveAgentModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: AgentConnection, private done: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("删除 {0} 的 agentNote 接入？", this.agent.name) });
    this.contentEl.createEl("p", { text: t("Skill 文件会先备份，再从加载位置移走；Agent 将不再使用这项 Skill。看板中的协作历史仍会保留。") });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: this.agent.skillPath });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(t("取消")).onClick(() => this.close()))
      .addButton((button) => {
        button.buttonEl.addClass("mod-warning");
        button.setButtonText(t("确认删除")).onClick(async () => {
          try { await this.plugin.forgetAgent(this.agent.name); await this.done(); this.close(); }
          catch (error) { new Notice(t("移除失败：{0}", (error as Error).message)); }
        });
      });
  }
}

class ManualInstallModal extends Modal {
  private copied = false;
  private checkedConnections: AgentConnection[] | null = null;
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("agentnote-connect-modal");
    this.render();
  }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createSpan({ cls: "agentnote-eyebrow", text: "AGENTNOTE · CONNECT" });
    this.contentEl.createEl("h2", { text: t("接入 Agent") });
    this.contentEl.createEl("p", { text: t("先查看完整安装任务，再复制给目标 Agent；完成后回到这里核对接入记录。") });
    const steps = this.contentEl.createDiv({ cls: "agentnote-connect-steps" });
    for (const [number, label, active] of [["01", t("查看任务"), true], ["02", t("发送给 Agent"), this.copied], ["03", t("核对接入"), this.checkedConnections !== null]] as const) {
      const step = steps.createDiv({ cls: active ? "is-active" : "" });
      step.createSpan({ text: number }); step.createSpan({ text: label });
    }
    const status = this.contentEl.createDiv({ cls: "agentnote-connect-status", attr: { role: "status", "aria-live": "polite" } });
    status.createEl("strong", { text: this.copied ? t("安装任务已复制") : t("安装任务已准备好") });
    status.createEl("p", { text: this.copied ? t("请粘贴给 Agent 并等待它完成安装；复制并不代表已接入。") : t("不同 Agent 可使用同一份安装任务，各自登记独立身份。") });
    if (this.checkedConnections !== null) {
      const result = this.contentEl.createDiv({ cls: "agentnote-connect-result" });
      result.createEl("strong", { text: this.checkedConnections.length ? t("当前接入记录") : t("暂未发现接入记录") });
      if (this.checkedConnections.length) for (const connection of this.checkedConnections) result.createEl("p", { text: `${connection.name} · ${connection.skillPath}` });
      else result.createEl("p", { text: t("确认 Agent 已执行安装任务后，再检查一次。") });
    }
    const port = this.plugin.server?.port;
    let actions: HTMLDivElement;
    if (port) {
      const prompt = renderManualInstallPrompt({ port });
      const details = this.contentEl.createEl("details", { cls: "agentnote-connect-task" });
      details.createEl("summary", { text: t("查看完整安装任务") });
      const text = details.createEl("textarea", { cls: "agentnote-manual-prompt", attr: { "aria-label": t("完整安装任务") } });
      text.value = prompt; text.readOnly = true;
      actions = this.contentEl.createDiv({ cls: "agentnote-connect-actions" });
      actions.createEl("button", { text: t("复制安装任务"), cls: "mod-cta" }).onclick = () => void (async () => {
        try {
          await navigator.clipboard.writeText(prompt);
          this.copied = true;
          this.render();
          new Notice(t("已复制手动安装任务。"));
        } catch (error) {
          details.open = true;
          new Notice(t("复制失败：{0}", (error as Error).message));
        }
      })();
    } else {
      this.contentEl.createEl("p", { text: t("当前仓库的本地服务未运行，请先在接入台启动服务。") });
      actions = this.contentEl.createDiv({ cls: "agentnote-connect-actions" });
      actions.createEl("button", { text: t("启动服务"), cls: "mod-cta" }).onclick = () => void (async () => { await this.plugin.startServer(); this.render(); })();
    }
    actions.createEl("button", { text: t("检查接入") }).onclick = () => void (async () => {
      try { this.checkedConnections = await this.plugin.connectedAgents(); this.render(); }
      catch (error) { new Notice(t("接入状态暂时不可用：{0}", (error as Error).message)); }
    })();
  }
}

class AgentPromptModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: AgentConnection, private done: () => Promise<void>) { super(app); }
  onOpen(): void { void this.load(); }
  private async load(): Promise<void> {
    let original: string;
    try { original = await this.plugin.connections.readSkill(this.agent); }
    catch (error) { this.contentEl.empty(); this.contentEl.createEl("p", { text: t("无法读取 Skill：{0}", (error as Error).message) }); return; }
    const { base, additional } = splitSkillInstructions(original);
    this.modalEl.addClass("agentnote-skill-modal");
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: t("{0} 的 Skill", this.agent.name) });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: this.agent.skillPath });
    this.contentEl.createEl("h3", { text: t("完整预览"), cls: "agentnote-skill-editor-label" });
    const preview = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt agentnote-prompt-editor" });
    preview.value = original; preview.readOnly = true;
    this.contentEl.createEl("h3", { text: t("附加要求"), cls: "agentnote-skill-editor-label" });
    const extra = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt agentnote-additional-input", attr: { placeholder: t("写给这个 Agent 的额外要求；保存后会显示在上方完整预览中。") } });
    extra.value = additional;
    const actions = new Setting(this.contentEl);
    let warned = false;
    const saveAdditional = async () => {
      const updated = withSkillInstructions(base, extra.value);
      if (updated === original) { new Notice(t("没有需要保存的修改。")); return; }
      try {
        await this.plugin.saveConnectedSkill(this.agent, original, updated);
        original = updated;
        preview.value = updated;
        await this.done();
        new Notice(t("附加要求已保存；Agent 可能需要新会话才能读取更新。"));
      } catch (error) { new Notice(t("保存失败：{0}", (error as Error).message)); }
    };
    actions.addButton((button) => button.setButtonText(t("保存附加要求")).setCta().onClick(() => {
      if (warned) { void saveAdditional(); return; }
      new UnlockPromptModal(this.app, () => { warned = true; void saveAdditional(); }).open();
    })).addButton((button) => button.setButtonText(t("直接编辑全文")).onClick(() => new UnlockPromptModal(this.app, () => {
      preview.readOnly = false; extra.readOnly = true; preview.focus(); actions.controlEl.empty();
      actions.addButton((save) => save.setButtonText(t("保存全文")).setCta().onClick(async () => {
        if (!preview.value.trim()) { new Notice(t("提示词不能为空。")); return; }
        try {
          await this.plugin.saveConnectedSkill(this.agent, original, preview.value);
          await this.done();
          await this.load();
          new Notice(t("Skill 已保存；Agent 可能需要新会话才能读取更新。"));
        } catch (error) { new Notice(t("保存失败：{0}", (error as Error).message)); }
      })).addButton((cancel) => cancel.setButtonText(t("取消修改")).onClick(() => void this.load()));
    }).open())).addButton((button) => button.setButtonText(t("关闭")).onClick(() => this.close()));
  }
}

class UnlockPromptModal extends Modal {
  constructor(app: App, private done: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: t("解锁提示词编辑？") });
    this.contentEl.createEl("p", { cls: "agentnote-prompt-risk", text: t("修改后可能导致接入失效。不同 agent 的缓存机制不同，保存并更新安装后，可能需要重启 agent 或新开对话才会生效。理解 skill 机制后再继续。") });
    new Setting(this.contentEl).addButton((button) => button.setButtonText(t("取消")).onClick(() => this.close())).addButton((button) => button.setButtonText(t("我理解，继续编辑")).onClick(() => { this.done(); this.close(); }));
  }
}

export class FeedbackModal extends Modal {
  private type = "问题反馈";
  private title = "";
  private details = "";
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: t("发送反馈") });
    this.contentEl.createEl("p", { text: t("填写反馈后，选择 GitHub 或反馈站提交。内容会先复制到剪贴板，再在系统默认浏览器打开对应页面。") });
    new Setting(this.contentEl).setName(t("类型")).addDropdown((dropdown) => dropdown.addOptions({ "问题反馈": t("问题反馈"), "功能建议": t("功能建议"), "使用体验": t("使用体验") }).setValue(this.type).onChange((value) => this.type = value));
    new Setting(this.contentEl).setName(t("标题")).addText((input) => input.setPlaceholder(t("一句话说明反馈")).onChange((value) => this.title = value));
    new Setting(this.contentEl).setName(t("详情")).addTextArea((input) => { input.setPlaceholder(t("发生了什么、你的预期是什么、如何复现（如适用）。")); input.inputEl.addClass("agentnote-full-width"); input.onChange((value) => this.details = value); });
    new Setting(this.contentEl).setName("GitHub Issue").setDesc(t("自动填好标题和详情，适合希望更快跟进的问题。"))
      .addButton((button) => button.setButtonText(t("前往 GitHub")).onClick(() => void this.submit("github")));
    new Setting(this.contentEl).setName(t("反馈站")).setDesc(t("国内访问更方便；打开后粘贴反馈内容。首次打开可能需要稍等。"))
      .addButton((button) => button.setButtonText(t("前往反馈站")).setCta().onClick(() => void this.submit("site")));
    new Setting(this.contentEl).addButton((button) => button.setButtonText(t("仅复制反馈内容")).onClick(() => void this.copy()));
  }
  private report(): string { return `## ${t(this.type)}\n\n${this.details.trim() || t("请补充具体情况。")}\n\n---\nagentNote ${this.plugin.manifest.version}`; }
  private valid(): boolean { if (this.title.trim()) return true; new Notice(t("请填写反馈标题。")); return false; }
  private async copy(): Promise<boolean> {
    if (!this.valid()) return false;
    try {
      await navigator.clipboard.writeText(`# [${t(this.type)}] ${this.title.trim()}\n\n${this.report()}`);
      new Notice(t("反馈内容已复制。")); return true;
    } catch (error) { new Notice(t("复制失败：{0}", (error as Error).message)); return false; }
  }
  private async submit(target: "github" | "site"): Promise<void> {
    if (!await this.copy()) return;
    const params = new URLSearchParams({ title: `[${t(this.type)}] ${this.title.trim()}`, body: this.report() });
    const url = target === "github"
      ? `https://github.com/xinxinrana/agentNote-Obsidian-/issues/new?${params.toString()}`
      : "https://agentnote-feedback.pocketbay.app/";
    this.contentEl.querySelector(".agentnote-feedback-fallback")?.remove();
    try {
      window.open(url, "_external");
      if (target === "site") new Notice(t("反馈站已打开，请粘贴反馈内容；首次启动时可稍等片刻。"), 6000);
      this.close();
    } catch {
      const fallback = this.contentEl.createDiv({ cls: "agentnote-feedback-fallback" });
      fallback.createEl("p", { text: t("无法自动打开浏览器，请复制链接手动访问。") });
      const link = fallback.createEl("input", { attr: { type: "text", readonly: "", "aria-label": t("反馈链接") } });
      link.value = url;
      link.onclick = () => link.select();
    }
  }
}

export class DataRepairModal extends Modal {
  private version = 0;
  constructor(app: App, private plugin: AgentNotePlugin, private reload: () => Promise<void>) { super(app); }
  onOpen(): void { void this.check(); }
  onClose(): void { this.version++; }
  private async check(): Promise<void> {
    const version = ++this.version;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("检查并修复") });
    this.contentEl.createEl("p", { text: t("正在检查数据…") });
    try {
      const issues = await this.plugin.store.inspectData();
      if (version !== this.version) return;
      this.render(issues);
    } catch (error) {
      if (version !== this.version) return;
      this.contentEl.createEl("p", { text: (error as Error).message });
      this.contentEl.createEl("button", { text: t("重新加载") }).onclick = () => void this.check();
    }
  }
  private render(issues: DataIssue[]): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("检查并修复") });
    if (!issues.length) {
      this.contentEl.createEl("p", { text: t("未发现数据文件异常，可以重新加载接入台。") });
      this.contentEl.createEl("button", { text: t("重新加载") }).onclick = async () => { await this.reload(); this.close(); };
      return;
    }
    this.contentEl.createEl("p", { text: t("可修复的问题会先保存原文件备份，再补齐缺失文件或合并明确的数据冲突。不会清空损坏的数据。") });
    const labels = { missing: t("文件缺失"), conflict: t("Git 冲突"), invalid: t("数据格式损坏"), unreadable: t("文件无法读取") };
    for (const issue of issues) {
      const row = this.contentEl.createDiv({ cls: "agentnote-section" });
      row.createEl("strong", { text: issue.file, cls: "agentnote-repair-file" });
      row.createEl("p", { text: `${labels[issue.kind]} · ${issue.canRepair ? t("可自动修复") : t("需要手动处理")}` });
      const open = row.createEl("button", { text: t("打开问题文件") });
      open.disabled = issue.kind === "missing";
      open.onclick = async () => {
        try {
          const { shell } = await import("electron");
          const error = await shell.openPath(path.join(this.plugin.store.root, issue.file));
          if (error) throw new Error(error);
        } catch (error) { new Notice(t("打开问题文件失败：{0}", (error as Error).message)); }
      };
    }
    if (issues.some(issue => issue.canRepair)) {
      const button = this.contentEl.createEl("button", { text: t("修复可恢复的数据"), cls: "mod-cta" });
      button.onclick = async () => {
        const version = this.version;
        button.disabled = true;
        try {
          const result = await this.plugin.store.repairData();
          await this.reload();
          if (version !== this.version) return;
          this.render(result.remaining);
          this.contentEl.createEl("p", { text: t("已修复 {0} 个文件，保存 {1} 份备份。", result.repaired.length, result.backups.length) });
          for (const backup of result.backups) this.contentEl.createEl("p", { text: backup });
        } catch (error) { new Notice(t("数据修复失败：{0}", (error as Error).message), 10000); button.disabled = false; }
      };
    }
    this.contentEl.createEl("button", { text: t("重新检查") }).onclick = async () => { await this.reload(); await this.check(); };
  }
}
