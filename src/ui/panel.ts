import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import type AgentNotePlugin from "../main";
import type { LiveAgentActivity } from "../main";
import { KNOWN_AGENTS, renderManualInstallPrompt } from "../core/skill";
import { agentNameKey, splitSkillInstructions, withSkillInstructions, type AgentConnection } from "../core/agentConnections";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import codexIcon from "../assets/agents/codex.png";
import workbuddyIcon from "../assets/agents/workbuddy.png";
import xiaojiWave from "../../assets/brand/xiaoji-wave.svg";
import { CompanionPet } from "./pet";
import { renderWorkflowDemo } from "./workflowDemo";
import { toBlob } from "html-to-image";
import { ACTIVITY_WEIGHTS, type DashboardInsights, type DocumentContribution, type InsightEvent, type InsightNote } from "../core/store";

export const AGENTNOTE_VIEW = "agentnote-view";
type ActivityLinkTarget = Pick<InsightEvent, "nodeId" | "documentId" | "shareId" | "path"> & Partial<Pick<InsightEvent, "type" | "targetKind">>;

const AGENT_ICONS: Record<string, string> = {
  "claude-code": claudeCodeIcon,
  codex: codexIcon,
  workbuddy: workbuddyIcon,
};

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
  private pet: CompanionPet | null = null;
  private recentActivityContainer: HTMLElement | null = null;
  private recentActivityList: HTMLElement | null = null;
  private recentActivityEmpty: HTMLElement | null = null;
  private pendingAgentActivity: { surface: HTMLElement; copy: HTMLElement; time: HTMLElement; agentName: string; title: string; targetKey: string; operations: LiveAgentActivity["operation"][]; receivedAt: number } | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: AgentNotePlugin) { super(leaf); }
  getViewType(): string { return AGENTNOTE_VIEW; }
  getDisplayText(): string { return "agentNote 接入台"; }
  getIcon(): string { return "bot"; }
  async onOpen(): Promise<void> { await this.refresh(); }
  async onClose(): Promise<void> { this.refreshVersion++; this.pet?.dispose(); this.pet = null; this.recentActivityContainer = null; this.recentActivityList = null; this.recentActivityEmpty = null; this.pendingAgentActivity = null; this.contentEl.empty(); }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    const insights = await this.plugin.store.getDashboardInsights();
    if (version !== this.refreshVersion) return;
    this.contentEl.empty(); this.contentEl.addClass("agentnote-panel");
    this.renderDashboard(insights);
    if (this.plugin.settings.showQuickStart) this.renderQuickStart();
    this.renderServer();
    const connections = await this.plugin.connectedAgents();
    if (version !== this.refreshVersion) return;
    this.renderAgents(connections);
  }
  private renderQuickStart(): void {
    const guide = this.contentEl.createDiv({ cls: "agentnote-quick-start" });
    const heading = guide.createDiv({ cls: "agentnote-section-heading" });
    const title = heading.createDiv(); title.createEl("span", { cls: "agentnote-eyebrow", text: "FIRST WORKFLOW" }); title.createEl("h4", { text: "第一次使用？三步开始" });
    const actions = heading.createDiv({ cls: "agentnote-quick-start-actions" });
    const open = actions.createEl("button", { text: "查看教程", cls: "mod-cta" });
    open.onclick = () => new QuickStartModal(this.app).open();
    const dismiss = actions.createEl("button", { text: "×", cls: "clickable-icon agentnote-quick-start-dismiss", attr: { "aria-label": "隐藏快速教程", title: "隐藏教程" } });
    dismiss.onclick = async () => {
      this.plugin.settings.showQuickStart = false;
      await this.plugin.saveSettings();
      this.plugin.refreshPanels();
      new Notice("快速教程已隐藏；可在“设置 → agentNote → 帮助与更新”中重新打开。", 5000);
    };
    const steps = guide.createDiv({ cls: "agentnote-quick-start-steps" });
    for (const [number, titleText, description] of [["01", "接入一个 agent", "在下方选择已安装的 agent 并完成接入。"], ["02", "分享一份资料", "右键文件或文件夹，复制 agentNote 地址。"], ["03", "直接开始对话", "把地址发给 agent，或说“写到 Obsidian”。"]] as const) {
      const step = steps.createDiv({ cls: "agentnote-quick-start-step" }); step.createEl("span", { text: number }); const copy = step.createDiv(); copy.createEl("strong", { text: titleText }); copy.createEl("small", { text: description });
    }
  }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return `创建「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-updated") return `更新「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-archived") return `归档「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-restored") return `恢复「${event.title ?? "未命名资料"}」`;
    if (event.type === "local-created") return `新建「${event.title ?? "未命名文档"}」`;
    if (event.type === "local-edited") return `编辑「${event.title ?? "未命名文档"}」`;
    if (event.type === "local-read") return `本地阅读「${event.title ?? "未命名文档"}」`;
    if (event.type === "local-moved") return `整理「${event.title ?? "未命名文档"}」`;
    if (event.type === "local-deleted") return `删除「${event.title ?? "未命名文档"}」`;
    if (event.type === "document-linked") return `连接「${event.title ?? "未命名文档"}」`;
    if (event.type === "share-created") return `分享「${event.title ?? "资料"}」`;
    return `访问分享链接「${event.title ?? "分享资料"}」`;
  }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private operationLabel(operation: LiveAgentActivity["operation"]): string {
    if (operation === "created") return "创建";
    if (operation === "updated") return "更新";
    if (operation === "archived") return "整理";
    return "读取";
  }
  private liveActivityText(agentName: string, title: string, operations: LiveAgentActivity["operation"][]): string {
    if (agentName === "分享链接") return `分享链接刚刚被访问「${title}」`;
    return `${agentName} 已${operations.map((operation) => this.operationLabel(operation)).join("并")}「${title}」`;
  }
  private activityTargetKey(target: ActivityLinkTarget): string {
    if (target.nodeId) return `node:${target.nodeId}`;
    if (target.documentId) return `document:${target.documentId}`;
    if (target.shareId) return `share:${target.shareId}`;
    return target.path ? `path:${target.path}` : "";
  }
  private activitySurface(item: HTMLElement, target: ActivityLinkTarget, title: string): HTMLElement {
    const canOpen = target.type !== "local-deleted" && target.targetKind !== "folder" && !!this.activityTargetKey(target);
    if (!canOpen) return item.createDiv({ cls: "agentnote-activity-row" });
    const row = item.createEl("button", { cls: "agentnote-activity-row is-link", attr: { "aria-label": `打开「${title}」` } });
    row.onclick = () => void this.openActivityTarget(target);
    return row;
  }
  private async openActivityTarget(target: ActivityLinkTarget): Promise<void> {
    try {
      const path = await this.plugin.store.activityFilePath(target);
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (!(file instanceof TFile)) throw new Error("原文件已不存在或不是文件");
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (error) { new Notice(`无法打开资料：${(error as Error).message}`); }
  }
  showAgentActivity(activity: LiveAgentActivity): void {
    if (activity.operation === "created" && activity.targetKind !== "folder") this.pet?.celebrate();
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
      pending.time.setText("刚刚");
      pending.receivedAt = now;
      pending.surface.addClass("is-new");
      window.setTimeout(() => pending.surface.removeClass("is-new"), 3_000);
      return;
    }
    const item = list.createEl("li");
    const surface = this.activitySurface(item, activity, activity.title);
    surface.addClass("is-new");
    const copy = surface.createEl("span", { text: this.liveActivityText(activity.agentName, activity.title, [activity.operation]) });
    const time = surface.createEl("time", { text: "刚刚" });
    list.prepend(item);
    while (list.children.length > 3) list.lastElementChild?.remove();
    this.pendingAgentActivity = { surface, copy, time, agentName: activity.agentName, title: activity.title, targetKey, operations: [activity.operation], receivedAt: now };
    window.setTimeout(() => surface.removeClass("is-new"), 3_000);
    window.setTimeout(() => { if (time.isConnected) time.setText(this.timeText(activity.at)); }, 3_500);
  }
  celebrateNewDocument(): void { this.pet?.celebrate(); }
  private renderDashboard(insights: DashboardInsights): void {
    this.recentActivityContainer = null;
    this.recentActivityList = null;
    this.recentActivityEmpty = null;
    this.pendingAgentActivity = null;
    const dashboard = this.contentEl.createDiv({ cls: "agentnote-dashboard" });
    const overview = dashboard.createDiv({ cls: "agentnote-dashboard-hero" });
    const heroHeading = overview.createDiv({ cls: "agentnote-hero-heading" });
    const heroCopy = heroHeading.createDiv();
    heroCopy.createEl("span", { cls: "agentnote-eyebrow", text: "本地知识洞察" });
    heroCopy.createEl("h4", { text: "知识正在持续进入工作流" });
    if (!this.pet) this.pet = new CompanionPet();
    this.pet.mount(heroHeading);
    overview.createEl("p", { text: insights.summary.weekActivityCount ? `本周完成 ${insights.summary.weekActivityCount} 次知识活动：建设 ${insights.summary.weekCreated}、维护与整理 ${insights.summary.weekUpdated}、分享 ${insights.summary.weekSharesCreated}、使用 ${insights.summary.weekResolves}。` : "创建、维护、使用或整理资料后，这里会留下完整的知识活动。" });
    const stats = overview.createDiv({ cls: "agentnote-metric-strip" });
    for (const [value, label] of [[insights.summary.weekActivityScore, "知识活跃分"], [insights.summary.weekUpdated, "本周更新"], [insights.summary.weekResolves, "本周复用"]] as const) {
      const stat = stats.createDiv({ cls: "agentnote-metric" }); stat.createEl("strong", { text: String(value) }); stat.createEl("span", { text: label });
    }
    const activity = dashboard.createDiv({ cls: "agentnote-home-activity" });
    this.recentActivityContainer = activity;
    const heading = activity.createDiv({ cls: "agentnote-section-heading" });
    heading.createEl("h4", { text: "最近动态" });
    const detail = heading.createEl("button", { text: "查看完整洞察", cls: "mod-cta" });
    detail.onclick = () => new InsightsModal(this.app, this.plugin).open();
    if (!insights.activities.length) this.recentActivityEmpty = activity.createEl("p", { cls: "agentnote-empty-copy", text: "创建并分享资料给 agent 后，这里会留下它进入工作流的记录。" });
    else {
      const list = activity.createEl("ul", { cls: "agentnote-activity-list" });
      this.recentActivityList = list;
      for (const event of insights.activities.slice(0, 3)) {
        const item = list.createEl("li");
        const row = this.activitySurface(item, event, event.title ?? "资料");
        row.createEl("span", { text: this.activityText(event) });
        row.createEl("time", { text: this.timeText(event.at) });
      }
    }
  }
  private renderServer(): void {
    const section = this.contentEl.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: "本地服务" });
    const running = !!this.plugin.server?.port;
    const port = this.plugin.server?.port ?? this.plugin.settings.port;
    const status = section.createDiv({ cls: `agentnote-service-status${running ? " is-running" : ""}`, attr: { role: "status", "aria-live": "polite" } });
    status.createSpan({ cls: "agentnote-service-indicator", attr: { "aria-hidden": "true" } });
    const copy = status.createDiv();
    copy.createEl("strong", { text: running ? "服务正在运行" : "服务未运行" });
    copy.createEl("span", { text: running ? "agent 可以读取分享和写入笔记" : "启动后，agent 才能读取分享和写入笔记" });
    if (running) status.createEl("code", { text: `127.0.0.1:${port}`, attr: { "aria-label": `本地服务地址 127.0.0.1:${port}` } });
    const button = section.createEl("button", { text: running ? "停止服务" : "启动服务", cls: running ? "mod-warning" : "mod-cta" });
    button.onclick = () => void (this.plugin.server ? this.plugin.stopServer() : this.plugin.startServer());
  }
  private renderAgents(connections: AgentConnection[]): void {
    const section = this.contentEl.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: "接入 agent" });
    section.createEl("p", { text: "把安装任务发给 agent；它安装后会回报本机 Skill 位置，随后可在这里编辑。" });
    const manual = section.createEl("button", { text: "接入其他 Agent" });
    manual.onclick = () => void this.copyInstallTask();
    const presetNames = new Set(KNOWN_AGENTS.map((agent) => agentNameKey(agent.name)));
    const entries = [
      ...KNOWN_AGENTS.map((agent) => ({ name: agent.name, id: agent.id, connection: connections.find((item) => agentNameKey(item.name) === agentNameKey(agent.name)) })),
      ...connections.filter((item) => !presetNames.has(agentNameKey(item.name))).map((item) => ({ name: item.name, id: "", connection: item })),
    ];
    for (const agent of entries) {
      const card = section.createDiv({ cls: "agentnote-agent-card" });
      const header = card.createDiv({ cls: "agentnote-agent-header" });
      if (agent.id) {
        const icon = header.createEl("img", { cls: "agentnote-agent-icon", attr: { src: AGENT_ICONS[agent.id], alt: `${agent.name} 图标` } });
        icon.decoding = "async";
      } else setIcon(header.createSpan({ cls: "agentnote-agent-icon" }), "bot");
      const identity = header.createDiv();
      identity.createEl("strong", { text: agent.name });
      const available = !!agent.connection && existsSync(agent.connection.skillPath);
      if (!available) identity.createEl("div", { cls: "agentnote-agent-status", text: agent.connection ? "本机文件不可用" : "未接入" });
      if (agent.connection) {
        const location = card.createDiv({ cls: "agentnote-agent-path" });
        location.createEl("span", { text: "Skill 位置" });
        location.createEl("code", { text: agent.connection.skillPath });
      }
      const actions = card.createDiv({ cls: "agentnote-node-actions agentnote-agent-actions" });
      if (!agent.connection) {
        actions.createEl("button", { text: "接入", cls: "mod-cta" }).onclick = () => void this.copyInstallTask();
      } else if (available) {
        actions.createEl("button", { text: "已接入", cls: "agentnote-connected-button", attr: { "aria-label": `已接入 ${agent.name}，打开 Skill 编辑` } }).onclick = () => new AgentPromptModal(this.app, this.plugin, agent.connection!, () => this.refresh()).open();
        actions.createEl("button", { text: "修改" }).onclick = () => new AgentPromptModal(this.app, this.plugin, agent.connection!, () => this.refresh(), true).open();
        actions.createEl("button", { text: "删除", cls: "mod-warning" }).onclick = () => new RemoveAgentModal(this.app, this.plugin, agent.connection!, () => this.refresh()).open();
      } else {
        actions.createEl("button", { text: "重新接入", cls: "mod-cta" }).onclick = () => void this.copyInstallTask();
        actions.createEl("button", { text: "删除", cls: "mod-warning" }).onclick = () => new RemoveAgentModal(this.app, this.plugin, agent.connection!, () => this.refresh()).open();
      }
    }
    this.renderFooter(section);
  }
  private async copyInstallTask(): Promise<void> {
    const prompt = renderManualInstallPrompt({ port: this.plugin.server?.port ?? this.plugin.settings.port });
    try { await navigator.clipboard.writeText(prompt); new ManualInstallModal(this.app, this.plugin).open(); new Notice("已复制安装任务，可直接粘贴给 Agent。"); }
    catch (error) { new Notice(`复制失败：${(error as Error).message}`); new ManualInstallModal(this.app, this.plugin).open(); }
  }
  private renderFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: "agentnote-panel-footer" });
    footer.createEl("small", { text: "作者 Evan" });
    footer.createEl("span", { text: "·", attr: { "aria-hidden": "true" } });
    const feedback = footer.createEl("button", { text: "反馈", cls: "agentnote-feedback-link" });
    feedback.onclick = () => new FeedbackModal(this.app, this.plugin).open();
  }
}

export class QuickStartModal extends Modal {
  private stopDemo: (() => void) | null = null;
  onOpen(): void {
    this.modalEl.addClass("agentnote-quick-start-modal");
    this.contentEl.empty();
    this.contentEl.createEl("span", { cls: "agentnote-eyebrow", text: "AGENTNOTE · QUICK START" });
    this.contentEl.createEl("h2", { text: "三分钟开始使用" });
    this.contentEl.createEl("p", { text: "完成一次接入、一次分享和一次对话，你就已经掌握 agentNote 的核心流程。" });
    this.stopDemo = renderWorkflowDemo(this.contentEl);
    const steps = this.contentEl.createEl("ol", { cls: "agentnote-guide-steps" });
    for (const [title, description] of [["确认本地服务", "在接入台确认绿色状态灯和“服务正在运行”。服务只在本机 127.0.0.1 上提供内容。"], ["接入一个 agent", "点击目标 Agent 的“接入”，把复制的任务发给它。安装并上报成功后，接入台会显示“已接入”。"], ["分享并开始工作", "右键文件或文件夹选择“agentNote: 分享给 agent”。把复制的地址发送给 agent，并说明要它总结、审阅、计划或更新什么。"]] as const) {
      const item = steps.createEl("li"); item.createEl("strong", { text: title }); item.createEl("p", { text: description });
    }
    const example = this.contentEl.createDiv({ cls: "agentnote-guide-example" }); example.createEl("strong", { text: "可直接发送给 agent" }); example.createEl("code", { text: "请读取这个资料，整理重点、待办和风险：<粘贴 agentNote 地址>" });
    const help = this.contentEl.createDiv({ cls: "agentnote-guide-help" }); help.createEl("span", { text: "需要完整图文说明？" }); help.createEl("a", { text: "打开 How to Use guide", cls: "external-link", attr: { href: "https://github.com/xinxinrana/agentNote-Obsidian-/blob/main/docs/How%20to%20Use.md", target: "_blank", rel: "noopener noreferrer" } });
  }
  onClose(): void { this.stopDemo?.(); this.stopDemo = null; }
}

type InsightTab = "overview" | "week" | "month" | "agents" | "timeline" | "archive";
type TimelineFilter = "all" | "construction" | "reuse" | "connection" | "organization";

class InsightsModal extends Modal {
  private tab: InsightTab = "overview";
  private timelineFilter: TimelineFilter = "all";
  private bulkUndoIds: string[] | null = null;
  private localArchiveUndo: { originalPath: string; archivedPath: string } | null = null;
  private privateView = false;
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-insights-modal"); void this.render(); }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private dateText(iso: string): string { return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }); }
  private displayTitle(title: string): string { return this.privateView ? "已匿名资料" : title; }
  private fileTitle(parent: HTMLElement, title: string, path: () => Promise<string>): void {
    if (this.privateView) { parent.createEl("strong", { text: this.displayTitle(title) }); return; }
    const button = parent.createEl("button", { cls: "agentnote-file-link", text: title, attr: { title: `打开「${title}」` } });
    button.onclick = () => void (async () => {
      try {
        const file = this.app.vault.getAbstractFileByPath(await path());
        if (!(file instanceof TFile)) throw new Error("文件已不存在");
        await this.app.workspace.getLeaf("tab").openFile(file);
        this.close();
      } catch (error) { new Notice(`无法打开资料：${(error as Error).message}`); }
    })();
  }
  private activeDays(trend: { count: number }[]): number { return trend.filter((point) => point.count > 0).length; }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return `创建「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-updated") return `更新「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-archived") return `归档「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-restored") return `恢复「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "local-created") return `新建「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "local-edited") return `编辑「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "local-read") return `本地阅读「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "local-moved") return `整理「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "local-deleted") return `删除「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "document-linked") return `连接「${this.displayTitle(event.title ?? "未命名文档")}」`;
    if (event.type === "share-created") return `分享「${event.title ?? "资料"}」`;
    return `访问分享链接「${this.displayTitle(event.title ?? "分享资料")}」`;
  }
  private async render(): Promise<void> {
    const insights = await this.plugin.store.getDashboardInsights();
    const agents = await this.plugin.store.getAgentInsights();
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "agentnote-modal-header" });
    const title = header.createDiv(); title.createEl("span", { cls: "agentnote-eyebrow", text: "AGENTNOTE · LOCAL PROFILE" }); title.createEl("h2", { text: "我的知识工作档案" });
    title.createEl("p", { text: "把本地资料真正投入工作流，并留下可回看的成果。" });
    const actions = header.createDiv({ cls: "agentnote-profile-actions" });
    const privacy = actions.createEl("button", { text: this.privateView ? "退出隐私展示" : "隐私展示" });
    privacy.onclick = () => { this.privateView = !this.privateView; void this.render(); };
    const share = actions.createEl("button", { text: "生成分享图", cls: "mod-cta" });
    share.onclick = () => new InsightShareModal(this.app, insights, this.privateView).open();
    const tabs = this.contentEl.createDiv({ cls: "agentnote-insight-tabs" });
    for (const [tab, label] of [["overview", "档案"], ["week", "本周"], ["month", "开始以来"], ["agents", "Agent"], ["timeline", "时间线"], ["archive", "整理"]] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.tab === tab ? "is-active" : "" });
      button.onclick = () => { this.tab = tab; void this.render(); };
    }
    const body = this.contentEl.createDiv({ cls: "agentnote-modal-body" });
    if (this.tab === "overview") this.renderOverview(body, insights, agents);
    if (this.tab === "week") {
      this.renderPeriod(body, { eyebrow: "WEEKLY REVIEW", title: "本周知识活动报告", description: "建设、使用、连接与整理共同构成真实的知识工作节奏。", trendTitle: "每日知识活动", rankingTitle: "本周协作资料" }, [[insights.summary.weekActivityScore, "知识活动值"], [insights.summary.weekCreated, "内容建设"], [insights.summary.weekUpdated, "维护整理"], [insights.summary.weekResolves, "资料使用"]], insights.weekly, insights.weeklyTrend, "weekly");
      this.renderDocumentContributions(body, insights.weeklyDocuments, "本周文档贡献");
    }
    if (this.tab === "month") {
      this.renderPeriod(body, { eyebrow: "ALL-TIME CONTRIBUTIONS", title: "开始以来的知识贡献", description: `从 ${this.dateText(insights.startedAt)} 的第一条记录开始。总值保留全部历史，记录墙展示最近 40 周。`, trendTitle: "最近 40 周知识贡献", rankingTitle: "开始以来协作资料" }, [[insights.allTimeTrend.filter((point) => point.count > 0).length, "近 40 周活跃天数"], [insights.summary.allTimeActivityScore, "累计知识活动值"], [insights.documents.reduce((total, entry) => total + entry.reuse, 0), "累计使用"], [insights.documents.length, "参与资料"]], insights.allTime, insights.allTimeTrend, "contributions");
      this.renderDocumentContributions(body, insights.documents, "文档贡献档案");
    }
    if (this.tab === "agents") this.renderAgents(body, agents);
    if (this.tab === "timeline") this.renderTimeline(body, insights);
    if (this.tab === "archive") this.renderArchive(body, insights);
  }
  private renderOverview(parent: HTMLElement, insights: DashboardInsights, agents: Awaited<ReturnType<AgentNotePlugin["store"]["getAgentInsights"]>>): void {
    const activeDays = this.activeDays(insights.weeklyTrend);
    const profile = parent.createDiv({ cls: "agentnote-profile-card" });
    const summary = profile.createDiv({ cls: "agentnote-profile-summary" });
    summary.createEl("span", { cls: "agentnote-profile-label", text: "近 7 天成果" });
    summary.createEl("strong", { text: `${insights.summary.weekActivityScore} 知识活动值` });
    summary.createEl("p", { text: insights.summary.weekActivityCount ? `建设 ${insights.summary.weekCreated} · 维护整理 ${insights.summary.weekUpdated} · 分享 ${insights.summary.weekSharesCreated} · 使用 ${insights.summary.weekResolves}` : "开始建设、使用或整理资料后，这里会记录完整的知识工作成果。" });
    const metrics = profile.createDiv({ cls: "agentnote-profile-metrics" });
    for (const [value, label] of [[insights.summary.weekActivityCount, "有效操作"], [activeDays, "活跃天数"], [agents.length, "协作 agent"]] as const) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createEl("span", { text: label });
    }

    const grid = parent.createDiv({ cls: "agentnote-profile-grid" });
    const rhythm = grid.createDiv({ cls: "agentnote-profile-section" });
    const rhythmHeading = rhythm.createDiv({ cls: "agentnote-profile-section-heading" });
    rhythmHeading.createEl("h3", { text: "本周工作节奏" });
    rhythmHeading.createEl("span", { text: `${activeDays} / 7 天活跃` });
    const days = rhythm.createDiv({ cls: "agentnote-profile-days" });
    const max = Math.max(1, ...insights.weeklyTrend.map((point) => point.count));
    for (const point of insights.weeklyTrend) {
      const day = days.createDiv({ cls: `agentnote-profile-day${point.count ? " is-active" : ""}`, attr: { title: `${point.label}：${point.count} 知识活跃分` } });
      if (point.count) day.setCssProps({ "--agentnote-activity-strength": `${Math.round((0.22 + point.count / max * 0.5) * 100)}%` });
      day.createEl("strong", { text: point.label }); day.createEl("span", { text: String(point.count) });
    }

    const next = grid.createDiv({ cls: "agentnote-profile-section agentnote-profile-next" });
    next.createEl("span", { cls: "agentnote-profile-label", text: "下一步" });
    if (insights.archiveCandidates.length) {
      next.createEl("h3", { text: `整理 ${insights.archiveCandidates.length} 条沉睡资料` });
      next.createEl("p", { text: "把暂未复用的旧资料归档，让下一次检索更轻快。" });
      const button = next.createEl("button", { text: "查看整理建议" });
      button.onclick = () => { this.tab = "archive"; void this.render(); };
    } else {
      next.createEl("h3", { text: insights.summary.weekActivityCount ? "继续积累可复用上下文" : "分享第一条工作资料" });
      next.createEl("p", { text: insights.summary.weekActivityCount ? "把高频资料固定下来，让每一次协作都从已有上下文开始。" : "从文件菜单选择“分享给 agent”，让资料立即进入工作流。" });
    }

    const highlights = parent.createDiv({ cls: "agentnote-profile-highlights" });
    const heading = highlights.createDiv({ cls: "agentnote-profile-section-heading" });
    heading.createEl("h3", { text: "本周协作资料" });
    heading.createEl("span", { text: "按实际使用次数排序" });
    if (!insights.weekly.length) highlights.createEl("p", { cls: "agentnote-empty-copy", text: "本地查看或被 agent 使用后，资料会在这里形成协作记录。" });
    else {
      const cards = highlights.createDiv({ cls: "agentnote-profile-note-list" });
      for (const [index, entry] of insights.weekly.entries()) {
        const card = cards.createDiv({ cls: "agentnote-profile-note" });
        card.createEl("span", { cls: "agentnote-profile-rank", text: String(index + 1).padStart(2, "0") });
        const detail = card.createDiv(); this.fileTitle(detail, entry.node.title, () => this.plugin.store.nodeFilePath(entry.node.id)); detail.createEl("small", { text: entry.reason });
        card.createEl("span", { cls: "agentnote-profile-use-count", text: `${entry.reads} 次` });
      }
    }
  }
  private renderTabHero(parent: HTMLElement, eyebrow: string, title: string, description: string, metricsData: readonly (readonly [number, string])[]): void {
    const hero = parent.createDiv({ cls: "agentnote-tab-hero" });
    const copy = hero.createDiv(); copy.createEl("span", { cls: "agentnote-profile-label", text: eyebrow }); copy.createEl("h3", { text: title }); copy.createEl("p", { text: description });
    const metrics = hero.createDiv({ cls: "agentnote-tab-hero-metrics" });
    for (const [value, label] of metricsData) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createEl("span", { text: label });
    }
  }
  private renderAgents(parent: HTMLElement, agents: Awaited<ReturnType<AgentNotePlugin["store"]["getAgentInsights"]>>): void {
    const uses = agents.reduce((total, agent) => total + agent.uses, 0);
    const writes = agents.reduce((total, agent) => total + agent.created + agent.updated, 0);
    this.renderTabHero(parent, "COLLABORATORS", "Agent 协作网络", agents.length ? "每一次读取、创建和更新，都会留下可回看的本地协作轨迹。" : "接入的 agent 开始调用后，这里会逐渐形成你的协作网络。", [[agents.length, "活跃 agent"], [uses, "资料读取"], [writes, "内容变更"]]);
    if (!agents.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: "还没有协作记录。完成一次资料分享或写入后，再回来看看它如何参与工作。" }); return; }
    const list = parent.createDiv({ cls: "agentnote-agent-insights" });
    for (const agent of agents) {
      const card = list.createDiv({ cls: "agentnote-agent-insight" });
      const heading = card.createDiv({ cls: "agentnote-agent-insight-heading" });
      heading.createEl("strong", { text: agent.name }); heading.createEl("span", { text: "协作中" });
      const stats = card.createDiv({ cls: "agentnote-agent-insight-stats" });
      for (const [value, label] of [[agent.uses, "读取资料"], [agent.created, "新建内容"], [agent.updated, "更新内容"]] as const) {
        const stat = stats.createDiv(); stat.createEl("strong", { text: String(value) }); stat.createEl("span", { text: label });
      }
      card.createEl("small", { text: `最近活动 · ${this.timeText(agent.lastActive)}` });
    }
  }
  private renderPeriod(parent: HTMLElement, header: { eyebrow: string; title: string; description: string; trendTitle: string; rankingTitle: string }, metricsData: readonly (readonly [number, string])[], notes: InsightNote[], trend: { label: string; count: number }[], mode: "weekly" | "contributions"): void {
    this.renderTabHero(parent, header.eyebrow, header.title, header.description, metricsData);
    const trendSection = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-trend" });
    const trendHeading = trendSection.createDiv({ cls: "agentnote-section-heading" }); trendHeading.createEl("h3", { text: header.trendTitle }); if (mode === "weekly") trendHeading.createEl("span", { text: "人的本地操作与 agent 协作共同计入" });
    const max = Math.max(1, ...trend.map((point) => point.count));
    if (mode === "contributions") this.renderContributionGraph(trendSection, trend, max);
    else {
      const bars = trendSection.createDiv({ cls: "agentnote-trend" });
      for (const point of trend) {
        const item = bars.createDiv({ cls: "agentnote-trend-item" });
        const bar = item.createDiv({ cls: "agentnote-trend-bar" }); bar.setCssProps({ "--agentnote-trend-height": `${Math.max(4, point.count / max * 100)}%` }); bar.setAttribute("aria-label", `${point.label}：${point.count} 知识活跃分`);
        item.createEl("span", { text: point.label });
      }
    }
    const ranking = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
    const rankingHeading = ranking.createDiv({ cls: "agentnote-section-heading" }); rankingHeading.createEl("h3", { text: header.rankingTitle }); rankingHeading.createEl("span", { text: "按实际复用排序 · 保护后不参与归档建议" });
    if (!notes.length) ranking.createEl("p", { cls: "agentnote-empty-copy", text: "这一周期还没有被读取的分享笔记。" });
    for (const [index, entry] of notes.entries()) {
      const card = ranking.createDiv({ cls: "agentnote-value-card" });
      card.createEl("span", { cls: "agentnote-value-rank", text: String(index + 1).padStart(2, "0") });
      const row = card.createDiv({ cls: "agentnote-value-title" }); this.fileTitle(row, entry.node.title, () => this.plugin.store.nodeFilePath(entry.node.id));
      if (entry.node.pinned) row.createEl("span", { cls: "agentnote-pin-badge", text: "已保护", attr: { title: "这条资料不会出现在“整理”中的归档建议里。" } });
      card.createEl("p", { text: entry.reason });
      if (entry.lastRead) card.createEl("small", { text: `最近使用：${this.timeText(entry.lastRead)}` });
      const pin = card.createEl("button", { text: entry.node.pinned ? "取消保护" : "保护不归档", attr: { title: entry.node.pinned ? "允许这条资料再次进入归档建议。" : "保护后，这条资料不会出现在“整理”中的归档建议里；不会修改内容或分享地址。" } });
      pin.onclick = () => void (async () => { pin.disabled = true; const pinned = !entry.node.pinned; await this.plugin.store.updateNode(entry.node.id, { pinned }); new Notice(pinned ? `已保护「${entry.node.title}」：它不会进入归档建议。` : `已取消保护「${entry.node.title}」。`); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
  private renderDocumentContributions(parent: HTMLElement, documents: DashboardInsights["documents"], title: string): void {
    const section = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
    const heading = section.createDiv({ cls: "agentnote-section-heading" }); heading.createEl("h3", { text: title }); heading.createEl("span", { text: "包含本地创建、阅读、编辑、引用与 agent 使用" });
    if (!documents.length) { section.createEl("p", { cls: "agentnote-empty-copy", text: "开始创建、使用或整理资料后，这里会形成可追溯的文档贡献档案。" }); return; }
    for (const [index, entry] of documents.slice(0, 8).entries()) {
      const card = section.createDiv({ cls: "agentnote-value-card" });
      card.createEl("span", { cls: "agentnote-value-rank", text: String(index + 1).padStart(2, "0") });
      const row = card.createDiv({ cls: "agentnote-value-title" }); this.fileTitle(row, entry.document.title, async () => entry.document.path); row.createEl("span", { cls: "agentnote-profile-use-count", text: `${entry.score}` });
      card.createEl("p", { text: `内容建设 ${entry.construction} · 协作复用 ${entry.reuse} · 知识连接 ${entry.connection} · 知识整理 ${entry.organization}` });
      if (entry.lastActive) card.createEl("small", { text: `最近活动：${this.timeText(entry.lastActive)}${title === "文档贡献档案" ? ` · 近 30 天活动值 ${entry.recentScore}` : ""}` });
      card.createEl("button", { text: "查看活动记录" }).onclick = () => new DocumentActivityModal(this.app, this.plugin, entry, this.privateView, title === "本周文档贡献").open();
    }
  }
  private renderContributionGraph(parent: HTMLElement, trend: { label: string; count: number }[], max: number): void {
    const min = Math.min(...trend.filter((point) => point.count > 0).map((point) => point.count));
    const firstDate = new Date(`${trend[0]?.label ?? "1970-01-01"}T00:00:00`);
    const leadingDays = firstDate.getDay();
    const weeks = Math.ceil((leadingDays + trend.length) / 7);
    const chart = parent.createDiv({ cls: "agentnote-contribution-chart" });
    window.requestAnimationFrame(() => { chart.scrollLeft = chart.scrollWidth; });
    const weekdays = chart.createDiv({ cls: "agentnote-contribution-weekdays" });
    for (const label of ["日", "", "二", "", "四", "", "六"]) weekdays.createEl("span", { text: label });
    const calendar = chart.createDiv({ cls: "agentnote-contribution-calendar" });
    calendar.setCssProps({ "--agentnote-contribution-weeks": String(weeks), "--agentnote-contribution-width": `${Math.max(13, weeks * 17 - 4)}px` });
    const months = calendar.createDiv({ cls: "agentnote-contribution-months" });
    const grid = calendar.createDiv({ cls: "agentnote-contribution-grid" });
    for (let index = 0; index < leadingDays; index++) grid.createEl("span", { cls: "agentnote-contribution-cell is-empty", attr: { "aria-hidden": "true" } });
    let lastMonthColumn = -2;
    for (const [index, point] of trend.entries()) {
      const date = new Date(`${point.label}T00:00:00`);
      const column = Math.floor((leadingDays + index) / 7);
      if ((index === 0 || date.getDate() === 1) && column - lastMonthColumn >= 2) {
        const label = months.createEl("span", { text: `${date.getMonth() + 1}月` });
        label.setCssProps({ "--agentnote-month-offset": `${column * 17}px` });
        lastMonthColumn = column;
      }
      const cell = grid.createEl("span", { cls: `agentnote-contribution-cell${point.count ? " is-active" : ""}`, attr: { "aria-label": `${point.label}：${point.count} 知识活跃分` } });
      if (point.count) cell.setCssProps(contributionShade(point.count, min, max));
    }
  }
  private renderTimeline(parent: HTMLElement, insights: DashboardInsights): void {
    const agents = new Set(insights.timeline.map((event) => event.actor?.name ?? event.actor?.id).filter(Boolean));
    this.renderTabHero(parent, "ACTIVITY LOG", "协作时间线", "分享链接每次成功访问都会留下记录；本地阅读指文件在 Obsidian 中保持打开超过 20 秒。", [[insights.timeline.length, "记录活动"], [agents.size, "参与 agent"], [insights.summary.weekResolves, "本周使用"]]);
    const filters = parent.createDiv({ cls: "agentnote-timeline-filters" });
    for (const [filter, label] of [["all", "全部"], ["construction", "建设"], ["reuse", "使用"], ["connection", "连接"], ["organization", "整理"]] as const) {
      const button = filters.createEl("button", { text: label, cls: this.timelineFilter === filter ? "is-active" : "" });
      button.onclick = () => { this.timelineFilter = filter; void this.render(); };
    }
    const visible = insights.timeline.filter((event) => this.timelineFilter === "all" || (this.timelineFilter === "construction" && ["node-created", "node-updated", "local-created", "local-edited"].includes(event.type)) || (this.timelineFilter === "reuse" && ["share-created", "share-resolved", "local-read"].includes(event.type)) || (this.timelineFilter === "connection" && event.type === "document-linked") || (this.timelineFilter === "organization" && ["node-archived", "node-restored", "local-moved", "local-deleted"].includes(event.type)));
    if (!visible.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: "还没有符合条件的活动。换一个筛选条件，或开始一次新的资料协作。" }); return; }
    const list = parent.createEl("ul", { cls: "agentnote-timeline" });
    for (const event of visible) {
      const item = list.createEl("li");
      const detail = item.createDiv();
      const chip = event.type === "document-linked" ? "连接" : ["share-resolved", "local-read"].includes(event.type) ? "使用" : event.type === "share-created" ? "分享" : ["node-created", "local-created"].includes(event.type) ? "创建" : ["local-moved", "local-deleted", "node-archived", "node-restored"].includes(event.type) ? "整理" : "维护";
      const title = detail.createDiv({ cls: "agentnote-timeline-title" }); title.createEl("strong", { text: this.activityText(event) }); title.createEl("span", { cls: `agentnote-event-chip is-${event.type}`, text: chip });
      detail.createEl("span", { text: [event.actor?.name ?? event.actor?.id ?? (event.type === "share-resolved" ? "访问方未识别" : event.origin === "local" ? "本地操作" : "未申报 agent"), event.actor?.sessionTitle, event.targetKind === "folder" ? "文件夹" : event.targetKind === "node" ? "笔记" : event.targetKind === "file" ? "文件" : undefined].filter(Boolean).join(" · ") });
      item.createEl("time", { text: this.timeText(event.at) });
    }
  }
  private renderArchive(parent: HTMLElement, insights: DashboardInsights): void {
    this.renderTabHero(parent, "KNOWLEDGE HYGIENE", "资料整理建议", insights.archiveCandidates.length ? "这里只给出可解释的建议，是否保留或归档始终由你决定。" : "目前没有需要优先整理的资料；被保护或近期使用的文档不会进入建议。", [[insights.archiveCandidates.length, "待整理资料"], [insights.summary.monthResolves, "本月协作"], [insights.monthly.length, "活跃资料"]]);
    const heading = parent.createDiv({ cls: "agentnote-section-heading agentnote-archive-heading" }); heading.createEl("h3", { text: insights.archiveCandidates.length ? "建议处理的资料" : "整理状态良好" });
    const nodeCandidates = insights.archiveCandidates.filter((candidate) => !!candidate.node);
    if (nodeCandidates.length) {
      const all = heading.createEl("button", { text: `归档 ${nodeCandidates.length} 条 agentNote 笔记`, cls: "mod-warning" });
      all.onclick = () => {
        const confirm = new Modal(this.app);
        confirm.contentEl.createEl("h3", { text: "确认批量归档？" });
        confirm.contentEl.createEl("p", { text: `将移动 ${nodeCandidates.length} 条 agentNote 笔记到归档目录；内容和分享地址都会保留，可立即撤销。` });
        const actions = confirm.contentEl.createDiv({ cls: "agentnote-node-actions" });
        actions.createEl("button", { text: "再看看" }).onclick = () => confirm.close();
        const submit = actions.createEl("button", { text: "确认归档", cls: "mod-warning" });
        submit.onclick = () => void (async () => { submit.disabled = true; const ids = nodeCandidates.map((candidate) => candidate.node!.id); try { await this.plugin.store.archiveNodes(ids, true); this.bulkUndoIds = ids; confirm.close(); new Notice(`已归档 ${ids.length} 条建议笔记。`); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(`归档失败：${(error as Error).message}`); submit.disabled = false; } })();
        confirm.open();
      };
    }
    if (this.bulkUndoIds?.length) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: `刚刚归档了 ${this.bulkUndoIds.length} 条笔记。` });
      const button = undo.createEl("button", { text: "撤销" }); button.onclick = () => void (async () => { await this.plugin.store.archiveNodes(this.bulkUndoIds!, false); this.bulkUndoIds = null; await this.render(); this.plugin.refreshPanels(); })();
    }
    if (this.localArchiveUndo) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: "刚刚归档了 vault 文档。" });
      const button = undo.createEl("button", { text: "撤销" }); button.onclick = () => void (async () => { const previous = this.localArchiveUndo!; try { await this.plugin.moveVaultDocument(previous.archivedPath, previous.originalPath); this.localArchiveUndo = null; await this.render(); } catch (error) { new Notice(`恢复失败：${(error as Error).message}`); } })();
    }
    if (!insights.archiveCandidates.length) parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: "没有需要优先整理的资料。" });
    const list = parent.createDiv({ cls: "agentnote-archive-list" });
    for (const { node, document, reason, uses, lastUsed } of insights.archiveCandidates) {
      const card = list.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, document.title, async () => node ? this.plugin.store.nodeFilePath(node.id) : document.path); card.createEl("span", { text: reason });
      if (uses) card.createEl("small", { text: `累计使用 ${uses} 次${lastUsed ? ` · 最近使用 ${this.dateText(lastUsed)}` : ""}` });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const keep = actions.createEl("button", { text: "保护，不归档", attr: { title: "尊重你的判断；保护后不会再推荐归档。" } }); keep.onclick = () => void (async () => { try { if (node) await this.plugin.store.updateNode(node.id, { pinned: true }); else await this.plugin.store.protectDocument(document.id, true); new Notice(`已保护「${document.title}」：它不会进入归档建议。`); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(`保护失败：${(error as Error).message}`); } })();
      const archive = actions.createEl("button", { text: "归档", cls: "mod-warning", attr: { title: node ? "移入 agentNote 归档目录，可撤销" : "移入 agentNote/归档文件，保留分享链接，可撤销" } }); archive.onclick = () => void (async () => { archive.disabled = true; try { if (node) await this.plugin.store.archiveNode(node.id, true); else this.localArchiveUndo = { originalPath: document.path, archivedPath: await this.plugin.archiveVaultDocument(document.path) }; await this.render(); this.plugin.refreshPanels(); } catch (error) { archive.disabled = false; new Notice(`归档失败：${(error as Error).message}`); } })();
    }
    const protectedDocuments = insights.protectedDocuments.filter((candidate) => !candidate.path.startsWith("agentNote/nodes/"));
    if (insights.protectedNodes.length || protectedDocuments.length) {
      const protectedSection = parent.createDiv({ cls: "agentnote-detail-section agentnote-period-ranking" });
      protectedSection.createEl("h3", { text: "你决定保留的资料" });
      protectedSection.createEl("p", { text: "这些资料不会进入自动整理建议；需要时可以取消保护。" });
      const protectedList = protectedSection.createDiv({ cls: "agentnote-archive-list" });
      for (const node of insights.protectedNodes) {
        const card = protectedList.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, node.title, () => this.plugin.store.nodeFilePath(node.id));
        const button = card.createEl("button", { text: "取消保护" }); button.onclick = () => void (async () => { await this.plugin.store.updateNode(node.id, { pinned: false }); await this.render(); this.plugin.refreshPanels(); })();
      }
      for (const document of protectedDocuments) {
        const card = protectedList.createDiv({ cls: "agentnote-archive-card" }); this.fileTitle(card, document.title, async () => document.path);
        const button = card.createEl("button", { text: "取消保护" }); button.onclick = () => void (async () => { await this.plugin.store.protectDocument(document.id, false); await this.render(); this.plugin.refreshPanels(); })();
      }
    }
  }
}

class DocumentActivityModal extends Modal {
  private visibleCount = 50;
  constructor(app: App, private plugin: AgentNotePlugin, private entry: DocumentContribution, private privateView: boolean, private weekly: boolean) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-insights-modal"); void this.render(); }
  private async render(): Promise<void> {
    const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const events = await this.plugin.store.listActivity({ documentId: this.entry.document.id, from: this.weekly ? monday.toISOString() : undefined });
    this.contentEl.empty();
    this.contentEl.createEl("span", { cls: "agentnote-eyebrow", text: "DOCUMENT ACTIVITY" });
    this.contentEl.createEl("h2", { text: this.privateView ? "已匿名资料" : this.entry.document.title });
    this.contentEl.createEl("p", { text: `${this.weekly ? "本周" : "累计"}活动值 ${this.entry.score} · 建设 ${this.entry.construction} · 使用 ${this.entry.reuse} · 连接 ${this.entry.connection} · 整理 ${this.entry.organization}` });
    if (!events.length) { this.contentEl.createEl("p", { cls: "agentnote-empty-copy", text: "这份文档暂时没有可展示的活动记录。" }); return; }
    const labels: Record<InsightEvent["type"], string> = {
      "node-created": "创建笔记", "node-updated": "更新笔记", "node-archived": "归档笔记", "node-restored": "恢复笔记",
      "share-created": "创建分享", "share-resolved": "访问分享链接", "local-created": "本地新建", "local-edited": "本地编辑",
      "local-read": "本地阅读", "local-moved": "移动或整理", "local-deleted": "删除文档", "document-linked": "被其他文档引用",
    };
    const list = this.contentEl.createEl("ul", { cls: "agentnote-timeline" });
    for (const event of events.slice(0, this.visibleCount)) {
      const item = list.createEl("li"); const detail = item.createDiv();
      const title = detail.createDiv({ cls: "agentnote-timeline-title" });
      title.createEl("strong", { text: labels[event.type] });
      title.createEl("span", { cls: "agentnote-event-chip", text: `+${ACTIVITY_WEIGHTS[event.type] ?? 0}` });
      detail.createEl("span", { text: event.actor?.name ?? (event.type === "share-resolved" ? "访问方未识别" : "本地操作") });
      item.createEl("time", { text: new Date(event.at).toLocaleString("zh-CN") });
    }
    if (events.length > this.visibleCount) this.contentEl.createEl("button", { text: `再看 ${Math.min(50, events.length - this.visibleCount)} 条` }).onclick = () => { this.visibleCount += 50; void this.render(); };
  }
}

class InsightShareModal extends Modal {
  private imageBlob: Blob | null = null;
  private imageUrl: string | null = null;
  constructor(app: App, private insights: DashboardInsights, private privateView: boolean) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-share-modal"); void this.render(); }
  onClose(): void { if (this.imageUrl) URL.revokeObjectURL(this.imageUrl); }
  private activeDays(): number { return this.insights.allTimeTrend.filter((point) => point.count > 0).length; }
  private titleForShare(): string { return this.privateView ? "已匿名资料" : this.insights.allTime[0]?.node.title ?? this.insights.documents[0]?.document.title ?? "等待第一条资料被使用"; }
  private renderShareCard(parent: HTMLElement): void {
    const activeDays = this.activeDays();
    const trend = this.insights.allTimeTrend;
    const max = Math.max(1, ...trend.map((point) => point.count));
    const min = Math.min(...trend.filter((point) => point.count > 0).map((point) => point.count));
    const start = new Date(this.insights.startedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    const brand = parent.createDiv({ cls: "agentnote-share-brand-row" });
    brand.createEl("span", { cls: "agentnote-share-brand", text: "agentNote · Local knowledge profile" });
    brand.createEl("img", { cls: "agentnote-companion", attr: { src: xiaojiWave, alt: "小记，agentNote 的笔记伙伴" } });
    parent.createEl("h2", { text: "开始以来的知识贡献" });
    parent.createEl("p", { cls: "agentnote-share-subtitle", text: `从 ${start} 的第一条记录开始，持续积累可复用的本地资料。` });
    const metrics = parent.createDiv({ cls: "agentnote-share-metrics" });
    for (const [value, label] of [[this.insights.summary.allTimeActivityScore, "累计知识活动值"], [this.insights.documents.length, "参与资料"], [activeDays, "近 40 周活跃天数"]] as const) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createEl("span", { text: label });
    }
    const contributions = parent.createDiv({ cls: "agentnote-share-contributions" });
    const heading = contributions.createDiv({ cls: "agentnote-share-contributions-heading" });
    heading.createEl("strong", { text: "最近 40 周知识贡献" });
    heading.createEl("span", { text: `${activeDays} 天有知识活动` });
    const chart = contributions.createDiv({ cls: "agentnote-share-contribution-chart" });
    const weekdays = chart.createDiv({ cls: "agentnote-share-contribution-weekdays" });
    for (const label of ["日", "", "二", "", "四", "", "六"]) weekdays.createEl("span", { text: label });
    const calendar = chart.createDiv({ cls: "agentnote-share-contribution-calendar" });
    const months = calendar.createDiv({ cls: "agentnote-share-contribution-months" });
    const grid = calendar.createDiv({ cls: "agentnote-share-contribution-grid" });
    const leadingDays = new Date(`${trend[0]?.label ?? "1970-01-01"}T00:00:00`).getDay();
    for (let index = 0; index < leadingDays; index++) grid.createEl("span", { cls: "agentnote-share-contribution-cell is-empty" });
    let lastMonthColumn = -2;
    for (const [index, point] of trend.entries()) {
      const date = new Date(`${point.label}T00:00:00`);
      const column = Math.floor((leadingDays + index) / 7);
      if ((index === 0 || date.getDate() === 1) && column - lastMonthColumn >= 2) {
        months.createEl("span", { text: `${date.getMonth() + 1}月` }).setCssProps({ "--agentnote-share-month-offset": `${column * 14}px` });
        lastMonthColumn = column;
      }
      const cell = grid.createEl("span", { cls: `agentnote-share-contribution-cell${point.count ? " is-active" : ""}`, attr: { title: `${point.label}：${point.count} 知识活跃分` } });
      if (point.count) cell.setCssProps(contributionShade(point.count, min, max));
    }
    const top = parent.createDiv({ cls: "agentnote-share-top-note" });
    top.createEl("span", { text: "开始以来的协作资料" });
    top.createEl("strong", { text: this.titleForShare() });
    top.createEl("small", { text: this.insights.allTime[0] ? `累计被读取 ${this.insights.allTime[0].reads} 次` : this.insights.documents[0] ? `累计知识活动值 ${this.insights.documents[0].score}` : "从一次分享开始建立可复用上下文" });
    parent.createEl("small", { cls: "agentnote-share-footer", text: "由 agentNote 在本地生成 · 内容不离开你的 vault" });
  }
  private async render(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "分享图预览" });
    this.contentEl.createEl("p", { text: "确认预览后，点击按钮即可将 PNG 图片复制到剪贴板。" });
    const preview = this.contentEl.createDiv({ cls: "agentnote-share-preview" });
    const card = preview.createDiv({ cls: "agentnote-share-card" });
    this.renderShareCard(card);
    const actions = this.contentEl.createDiv({ cls: "agentnote-share-actions" });
    const copy = actions.createEl("button", { text: "正在生成分享图…", cls: "mod-cta" });
    copy.disabled = true;
    actions.createEl("button", { text: "关闭" }).onclick = () => this.close();
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const blob = await toBlob(card, { cacheBust: true, pixelRatio: 2 });
      if (!blob) throw new Error("未生成图片");
      this.imageBlob = blob;
      this.imageUrl = URL.createObjectURL(blob);
      preview.empty();
      preview.createEl("img", { cls: "agentnote-share-image", attr: { src: this.imageUrl, alt: "知识工作档案分享图预览" } });
      copy.setText("复制图片到剪贴板");
      copy.disabled = false;
      copy.onclick = () => void this.copyImage();
    } catch (error) {
      copy.setText("分享图生成失败");
      new Notice(`分享图生成失败：${(error as Error).message}`);
    }
  }
  private async copyImage(): Promise<void> {
    if (!this.imageBlob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": this.imageBlob })]);
      new Notice("分享图已复制到剪贴板，可直接粘贴发送。");
    } catch {
      new Notice("复制图片失败，请确认 Obsidian 已获得系统剪贴板权限。");
    }
  }
}

export class BulkActivityModal extends Modal {
  private remember = false;
  private decided = false;
  constructor(app: App, private count: number, private done: (record: boolean, remember: boolean) => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: "检测到大量文件变动" });
    this.contentEl.createEl("p", { text: `短时间内检测到 ${this.count} 次本地操作。可能是 Git 同步或批量整理，要把它们计入知识活动吗？` });
    new Setting(this.contentEl).setName("记住这次选择，以后不再提示").addToggle((toggle) => toggle.onChange((value) => { this.remember = value; }));
    const actions = this.contentEl.createDiv({ cls: "agentnote-bulk-actions" });
    actions.createEl("button", { text: "不计入活动（推荐）", cls: "mod-cta" }).onclick = () => this.choose(false);
    actions.createEl("button", { text: "计入活动" }).onclick = () => this.choose(true);
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
    this.contentEl.createEl("h2", { text: `删除 ${this.agent.name} 的 agentNote 接入？` });
    this.contentEl.createEl("p", { text: "Skill 文件会先备份，再从加载位置移走；Agent 将不再使用这项 Skill。看板中的协作历史仍会保留。" });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: this.agent.skillPath });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => {
        button.buttonEl.addClass("mod-warning");
        button.setButtonText("确认删除").onClick(async () => {
          try { await this.plugin.forgetAgent(this.agent.name); await this.done(); this.close(); }
          catch (error) { new Notice(`移除失败：${(error as Error).message}`); }
        });
      });
  }
}

class ManualInstallModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "接入 Agent" });
    this.contentEl.createEl("p", { text: "安装任务已复制。将它发给目标 Agent；所有 Agent 使用同一个本地 Skill 地址与上报流程。" });
    const prompt = renderManualInstallPrompt({ port: this.plugin.server?.port ?? this.plugin.settings.port });
    const text = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt" });
    text.value = prompt; text.readOnly = true;
    new Setting(this.contentEl).addButton((button) => button.setButtonText("复制安装任务").setCta().onClick(async () => {
      await navigator.clipboard.writeText(prompt); new Notice("已复制手动安装任务。");
    })).addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }
}

class AgentPromptModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: AgentConnection, private done: () => Promise<void>, private focusAdditional = false) { super(app); }
  onOpen(): void { void this.load(); }
  private async load(): Promise<void> {
    let original: string;
    try { original = await this.plugin.connections.readSkill(this.agent); }
    catch (error) { this.contentEl.empty(); this.contentEl.createEl("p", { text: `无法读取 Skill：${(error as Error).message}` }); return; }
    const { base, additional } = splitSkillInstructions(original);
    this.modalEl.addClass("agentnote-skill-modal");
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: `${this.agent.name} 的 Skill` });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: this.agent.skillPath });
    this.contentEl.createEl("h3", { text: "完整预览", cls: "agentnote-skill-editor-label" });
    const preview = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt agentnote-prompt-editor" });
    preview.value = original; preview.readOnly = true;
    this.contentEl.createEl("h3", { text: "附加要求", cls: "agentnote-skill-editor-label" });
    const extra = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt agentnote-additional-input", attr: { placeholder: "写给这个 Agent 的额外要求；保存后会显示在上方完整预览中。" } });
    extra.value = additional;
    if (this.focusAdditional) extra.focus();
    const actions = new Setting(this.contentEl);
    let warned = false;
    const saveAdditional = async () => {
      const updated = withSkillInstructions(base, extra.value);
      if (updated === original) { new Notice("没有需要保存的修改。"); return; }
      try {
        await this.plugin.saveConnectedSkill(this.agent, original, updated);
        original = updated;
        preview.value = updated;
        await this.done();
        new Notice("附加要求已保存；Agent 可能需要新会话才能读取更新。");
      } catch (error) { new Notice(`保存失败：${(error as Error).message}`); }
    };
    actions.addButton((button) => button.setButtonText("保存附加要求").setCta().onClick(() => {
      if (warned) { void saveAdditional(); return; }
      new UnlockPromptModal(this.app, () => { warned = true; void saveAdditional(); }).open();
    })).addButton((button) => button.setButtonText("直接编辑全文").onClick(() => new UnlockPromptModal(this.app, () => {
      preview.readOnly = false; extra.readOnly = true; preview.focus(); actions.controlEl.empty();
      actions.addButton((save) => save.setButtonText("保存全文").setCta().onClick(async () => {
        if (!preview.value.trim()) { new Notice("提示词不能为空。"); return; }
        try {
          await this.plugin.saveConnectedSkill(this.agent, original, preview.value);
          await this.done();
          await this.load();
          new Notice("Skill 已保存；Agent 可能需要新会话才能读取更新。");
        } catch (error) { new Notice(`保存失败：${(error as Error).message}`); }
      })).addButton((cancel) => cancel.setButtonText("取消修改").onClick(() => void this.load()));
    }).open())).addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }
}

class UnlockPromptModal extends Modal {
  constructor(app: App, private done: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: "解锁提示词编辑？" });
    this.contentEl.createEl("p", { cls: "agentnote-prompt-risk", text: "修改后可能导致接入失效。不同 agent 的缓存机制不同，保存并更新安装后，可能需要重启 agent 或新开对话才会生效。理解 skill 机制后再继续。" });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("取消").onClick(() => this.close())).addButton((button) => button.setButtonText("我理解，继续编辑").onClick(() => { this.done(); this.close(); }));
  }
}

export class FeedbackModal extends Modal {
  private type = "问题反馈";
  private title = "";
  private details = "";
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: "发送反馈" });
    this.contentEl.createEl("p", { text: "反馈会先复制到剪贴板，再在系统默认浏览器打开 GitHub Issue。GitHub 登录由你的浏览器账户处理。" });
    new Setting(this.contentEl).setName("类型").addDropdown((dropdown) => dropdown.addOptions({ "问题反馈": "问题反馈", "功能建议": "功能建议", "使用体验": "使用体验" }).setValue(this.type).onChange((value) => this.type = value));
    new Setting(this.contentEl).setName("标题").addText((input) => input.setPlaceholder("一句话说明反馈").onChange((value) => this.title = value));
    new Setting(this.contentEl).setName("详情").addTextArea((input) => { input.setPlaceholder("发生了什么、你的预期是什么、如何复现（如适用）。"); input.inputEl.addClass("agentnote-full-width"); input.onChange((value) => this.details = value); });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("复制反馈").onClick(() => void this.copy())).addButton((button) => button.setButtonText("复制并在浏览器提交").setCta().onClick(() => void this.submit()));
  }
  private report(): string { return `## ${this.type}\n\n${this.details.trim() || "请补充具体情况。"}\n\n---\nagentNote ${this.plugin.manifest.version}`; }
  private valid(): boolean { if (this.title.trim()) return true; new Notice("请填写反馈标题。"); return false; }
  private async copy(): Promise<boolean> {
    if (!this.valid()) return false;
    await navigator.clipboard.writeText(`# [${this.type}] ${this.title.trim()}\n\n${this.report()}`);
    new Notice("反馈内容已复制。"); return true;
  }
  private async submit(): Promise<void> {
    if (!await this.copy()) return;
    const params = new URLSearchParams({ title: `[${this.type}] ${this.title.trim()}`, body: this.report() });
    try {
      const { shell } = require("electron") as typeof import("electron");
      await shell.openExternal(`https://github.com/xinxinrana/agentNote-Obsidian-/issues/new?${params.toString()}`);
      this.close();
    } catch (error) { new Notice(`无法打开系统浏览器：${(error as Error).message}`); }
  }
}
