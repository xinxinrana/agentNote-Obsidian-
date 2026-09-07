import { App, ItemView, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type AgentNotePlugin from "../main";
import { renderManualInstallPrompt, renderSkillMd, type DetectedAgent } from "../core/skill";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import codexIcon from "../assets/agents/codex.png";
import workbuddyIcon from "../assets/agents/workbuddy.png";
import type { DashboardInsights, InsightEvent, InsightNote } from "../core/store";

export const AGENTNOTE_VIEW = "agentnote-view";

const AGENT_ICONS: Record<string, string> = {
  "claude-code": claudeCodeIcon,
  codex: codexIcon,
  workbuddy: workbuddyIcon,
};

export class AgentNoteView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: AgentNotePlugin) { super(leaf); }
  getViewType(): string { return AGENTNOTE_VIEW; }
  getDisplayText(): string { return "agentNote 接入台"; }
  getIcon(): string { return "bot"; }
  async onOpen(): Promise<void> { await this.refresh(); }

  async refresh(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass("agentnote-panel");
    this.contentEl.createEl("h3", { text: "agentNote 接入台" });
    await this.renderDashboard();
    this.renderServer();
    this.renderAgents(this.plugin.detectedAgents());
  }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return "新建了一条笔记";
    if (event.type === "node-updated") return "更新了一条笔记";
    if (event.type === "node-archived") return "归档了一条笔记";
    if (event.type === "node-restored") return "恢复了一条笔记";
    return `读取「${event.title ?? "分享资料"}」`;
  }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private async renderDashboard(): Promise<void> {
    const insights = await this.plugin.store.getDashboardInsights();
    const dashboard = this.contentEl.createDiv({ cls: "agentnote-dashboard" });
    const overview = dashboard.createDiv({ cls: "agentnote-dashboard-hero" });
    overview.createEl("span", { cls: "agentnote-eyebrow", text: "本地知识洞察" });
    overview.createEl("h4", { text: "资料正在为 agent 工作" });
    overview.createEl("p", { text: `本周有 ${insights.summary.weekUsedNotes} 条笔记通过 ${insights.summary.weekResolves} 次链接解析进入工作流。` });
    const stats = overview.createDiv({ cls: "agentnote-metric-strip" });
    for (const [value, label] of [[insights.summary.weekCreated, "本周创建"], [insights.summary.weekResolves, "本周使用"], [insights.summary.weekUsedNotes, "使用资料"]] as const) {
      const stat = stats.createDiv({ cls: "agentnote-metric" }); stat.createEl("strong", { text: String(value) }); stat.createEl("span", { text: label });
    }
    const activity = dashboard.createDiv({ cls: "agentnote-home-activity" });
    const heading = activity.createDiv({ cls: "agentnote-section-heading" });
    heading.createEl("h4", { text: "最近动态" });
    const detail = heading.createEl("button", { text: "查看完整洞察", cls: "mod-cta" });
    detail.onclick = () => new InsightsModal(this.app, this.plugin).open();
    if (!insights.activities.length) activity.createEl("p", { cls: "agentnote-empty-copy", text: "创建并分享资料给 agent 后，这里会留下它进入工作流的记录。" });
    else {
      const list = activity.createEl("ul", { cls: "agentnote-activity-list" });
      for (const event of insights.activities.slice(0, 3)) {
        const item = list.createEl("li"); item.createEl("span", { text: this.activityText(event) }); item.createEl("time", { text: this.timeText(event.at) });
      }
    }
  }
  private renderServer(): void {
    const section = this.contentEl.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: "本地服务" });
    const port = this.plugin.server?.port ?? this.plugin.settings.port;
    section.createEl("p", { text: this.plugin.server ? `● 正在运行 · http://127.0.0.1:${port}` : "○ 未运行：agent 暂时无法读取或写入" });
    const button = section.createEl("button", { text: this.plugin.server ? "停止服务" : "启动服务" });
    button.onclick = () => void (this.plugin.server ? this.plugin.stopServer() : this.plugin.startServer());
  }
  private renderAgents(agents: DetectedAgent[]): void {
    const section = this.contentEl.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: "接入 agent" });
    section.createEl("p", { text: "接入会在该 agent 的长期 skill 目录写入一份 agentNote 使用说明。" });
    const manual = section.createEl("button", { text: "手动接入任意 agent" });
    manual.onclick = () => new ManualInstallModal(this.app, this.plugin).open();
    for (const agent of agents) {
      const profile = this.plugin.profile(agent.id);
      const card = section.createDiv({ cls: "agentnote-agent-card" });
      const header = card.createDiv({ cls: "agentnote-agent-header" });
      const icon = header.createEl("img", { cls: "agentnote-agent-icon", attr: { src: AGENT_ICONS[agent.id], alt: `${agent.name} 图标` } });
      icon.decoding = "async";
      const identity = header.createDiv();
      identity.createEl("strong", { text: agent.name });
      identity.createEl("div", { cls: `agentnote-agent-status ${agent.installed && profile.enabled ? "is-connected" : ""}`, text: !agent.available ? "未检测到安装" : agent.installed && profile.enabled ? "已接入" : "未接入" });
      if (!agent.available) {
        const actions = card.createDiv({ cls: "agentnote-node-actions" });
        actions.createEl("a", { text: "前往官网安装", cls: "external-link", attr: { href: agent.website, target: "_blank", rel: "noopener noreferrer", "aria-label": `在浏览器中打开 ${agent.name} 官网` } });
        continue;
      }
      card.createEl("div", { cls: "agentnote-agent-path", text: `安装位置：${agent.skillDir}` });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const install = actions.createEl("button", { text: agent.installed ? "更新接入" : "接入 agentNote", cls: "mod-cta" });
      install.onclick = () => void this.plugin.installAgent(agent);
      const edit = actions.createEl("button", { text: "管理提示词" });
      edit.onclick = () => new AgentPromptModal(this.app, this.plugin, agent, () => this.refresh()).open();
      if (agent.installed) {
        const disable = actions.createEl("button", { text: "移除接入", cls: "mod-warning" });
        disable.onclick = () => new RemoveAgentModal(this.app, this.plugin, agent, () => this.refresh()).open();
      }
    }
  }
}

type InsightTab = "week" | "month" | "agents" | "timeline" | "archive";
type TimelineFilter = "all" | "created" | "used" | "changed";

class InsightsModal extends Modal {
  private tab: InsightTab = "week";
  private timelineFilter: TimelineFilter = "all";
  private bulkUndoIds: string[] | null = null;
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-insights-modal"); void this.render(); }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return "创建笔记";
    if (event.type === "node-updated") return "更新笔记";
    if (event.type === "node-archived") return "归档笔记";
    if (event.type === "node-restored") return "恢复笔记";
    return `读取「${event.title ?? "分享资料"}」`;
  }
  private async render(): Promise<void> {
    const insights = await this.plugin.store.getDashboardInsights();
    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "agentnote-modal-header" });
    const title = header.createDiv(); title.createEl("span", { cls: "agentnote-eyebrow", text: "完整洞察" }); title.createEl("h2", { text: "知识使用看板" });
    const tabs = this.contentEl.createDiv({ cls: "agentnote-insight-tabs" });
    for (const [tab, label] of [["week", "本周"], ["month", "本月"], ["agents", "Agent"], ["timeline", "时间线"], ["archive", "整理"]] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.tab === tab ? "is-active" : "" });
      button.onclick = () => { this.tab = tab; void this.render(); };
    }
    const body = this.contentEl.createDiv({ cls: "agentnote-modal-body" });
    if (this.tab === "week") this.renderPeriod(body, [[insights.summary.weekResolves, "本周使用"], [insights.summary.weekCreated, "本周创建"], [insights.summary.weekUsedNotes, "使用资料"]], insights.weekly, insights.weeklyTrend, false);
    if (this.tab === "month") this.renderPeriod(body, [[insights.summary.monthResolves, "本月使用"], [insights.monthly.length, "高价值资料"], [insights.archiveCandidates.length, "待整理资料"]], insights.monthly, insights.monthlyTrend, true);
    if (this.tab === "agents") await this.renderAgents(body);
    if (this.tab === "timeline") this.renderTimeline(body, insights);
    if (this.tab === "archive") this.renderArchive(body, insights);
  }
  private async renderAgents(parent: HTMLElement): Promise<void> {
    const agents = await this.plugin.store.getAgentInsights();
    parent.createEl("p", { cls: "agentnote-empty-copy", text: "来源由 agent 在每次 API 调用时申报，用于查看本地工作轨迹。" });
    if (!agents.length) { parent.createEl("p", { cls: "agentnote-empty-copy", text: "已接入 agent 开始调用后，这里会显示使用、创建和更新记录。" }); return; }
    const list = parent.createDiv({ cls: "agentnote-agent-insights" });
    for (const agent of agents) {
      const card = list.createDiv({ cls: "agentnote-agent-insight" });
      card.createEl("strong", { text: agent.name });
      const stats = card.createDiv({ cls: "agentnote-agent-insight-stats" });
      stats.createEl("span", { text: `${agent.uses} 次使用` }); stats.createEl("span", { text: `${agent.created} 次创建` }); stats.createEl("span", { text: `${agent.updated} 次更新` });
      card.createEl("small", { text: `最近活动：${this.timeText(agent.lastActive)}` });
    }
  }
  private renderPeriod(parent: HTMLElement, metricsData: readonly (readonly [number, string])[], notes: InsightNote[], trend: { label: string; count: number }[], monthly: boolean): void {
    const metrics = parent.createDiv({ cls: "agentnote-detail-metrics" });
    for (const [value, label] of metricsData) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createEl("span", { text: label });
    }
    const trendSection = parent.createDiv({ cls: "agentnote-detail-section" });
    trendSection.createEl("h3", { text: monthly ? "每日使用" : "每日使用趋势" });
    const max = Math.max(1, ...trend.map((point) => point.count));
    if (monthly) {
      const heatmap = trendSection.createDiv({ cls: "agentnote-heatmap" });
      for (const point of trend) {
        const cell = heatmap.createEl("span", { cls: `agentnote-heatmap-cell${point.count ? " is-used" : ""}`, attr: { "aria-label": `${point.label} 日：${point.count} 次使用`, title: `${point.label} 日：${point.count} 次使用` } });
        if (point.count) cell.setCssProps({ "--agentnote-heatmap-opacity": String(0.3 + point.count / max * 0.7) });
      }
    } else {
      const bars = trendSection.createDiv({ cls: "agentnote-trend" });
      for (const point of trend) {
        const item = bars.createDiv({ cls: "agentnote-trend-item" });
        const bar = item.createDiv({ cls: "agentnote-trend-bar" }); bar.setCssProps({ "--agentnote-trend-height": `${Math.max(4, point.count / max * 100)}%` }); bar.setAttribute("aria-label", `${point.label}：${point.count} 次使用`);
        item.createEl("span", { text: point.label });
      }
    }
    const ranking = parent.createDiv({ cls: "agentnote-detail-section" });
    ranking.createEl("h3", { text: "最有价值的资料" });
    if (!notes.length) ranking.createEl("p", { cls: "agentnote-empty-copy", text: "这一周期还没有被读取的分享笔记。" });
    for (const entry of notes) {
      const card = ranking.createDiv({ cls: "agentnote-value-card" });
      const row = card.createDiv({ cls: "agentnote-value-title" }); row.createEl("strong", { text: entry.node.title });
      if (entry.node.pinned) row.createEl("span", { cls: "agentnote-pin-badge", text: "已固定" });
      card.createEl("p", { text: entry.reason });
      if (entry.lastRead) card.createEl("small", { text: `最近使用：${this.timeText(entry.lastRead)}` });
      const pin = card.createEl("button", { text: entry.node.pinned ? "取消固定" : "固定" });
      pin.onclick = () => void (async () => { pin.disabled = true; await this.plugin.store.updateNode(entry.node.id, { pinned: !entry.node.pinned }); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
  private renderTimeline(parent: HTMLElement, insights: DashboardInsights): void {
    const filters = parent.createDiv({ cls: "agentnote-timeline-filters" });
    for (const [filter, label] of [["all", "全部"], ["created", "创建"], ["used", "使用"], ["changed", "变更"]] as const) {
      const button = filters.createEl("button", { text: label, cls: this.timelineFilter === filter ? "is-active" : "" });
      button.onclick = () => { this.timelineFilter = filter; void this.render(); };
    }
    const visible = insights.timeline.filter((event) => this.timelineFilter === "all" || (this.timelineFilter === "created" && event.type === "node-created") || (this.timelineFilter === "used" && event.type === "share-resolved") || (this.timelineFilter === "changed" && ["node-updated", "node-archived", "node-restored"].includes(event.type)));
    if (!visible.length) { parent.createEl("p", { cls: "agentnote-empty-copy", text: "还没有符合条件的活动。" }); return; }
    const list = parent.createEl("ul", { cls: "agentnote-timeline" });
    for (const event of visible) {
      const item = list.createEl("li");
      const detail = item.createDiv(); detail.createEl("strong", { text: this.activityText(event) });
      detail.createEl("span", { text: [event.actor?.name ?? event.actor?.id ?? "未申报 agent", event.actor?.sessionTitle, event.targetKind === "folder" ? "文件夹" : event.targetKind === "node" ? "笔记" : "文件"].filter(Boolean).join(" · ") });
      item.createEl("time", { text: this.timeText(event.at) });
    }
  }
  private renderArchive(parent: HTMLElement, insights: DashboardInsights): void {
    const heading = parent.createDiv({ cls: "agentnote-section-heading" }); heading.createEl("h3", { text: `建议归档 · ${insights.archiveCandidates.length}` });
    if (insights.archiveCandidates.length) {
      const all = heading.createEl("button", { text: `归档全部建议（${insights.archiveCandidates.length}）`, cls: "mod-warning" });
      all.onclick = () => void (async () => { all.disabled = true; const ids = insights.archiveCandidates.map((node) => node.id); try { await this.plugin.store.archiveNodes(ids, true); this.bulkUndoIds = ids; new Notice(`已归档 ${ids.length} 条建议笔记。`); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(`归档失败：${(error as Error).message}`); all.disabled = false; } })();
    }
    if (this.bulkUndoIds?.length) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: `刚刚归档了 ${this.bulkUndoIds.length} 条笔记。` });
      const button = undo.createEl("button", { text: "撤销" }); button.onclick = () => void (async () => { await this.plugin.store.archiveNodes(this.bulkUndoIds!, false); this.bulkUndoIds = null; await this.render(); this.plugin.refreshPanels(); })();
    }
    if (!insights.archiveCandidates.length) { parent.createEl("p", { cls: "agentnote-empty-copy", text: "没有需要整理的低使用笔记。固定笔记不会被推荐归档。" }); return; }
    const list = parent.createDiv({ cls: "agentnote-archive-list" });
    for (const node of insights.archiveCandidates) {
      const card = list.createDiv({ cls: "agentnote-archive-card" }); card.createEl("strong", { text: node.title }); card.createEl("span", { text: "创建满 30 天，未被读取，且近 30 天未更新。" });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const keep = actions.createEl("button", { text: "固定并保留" }); keep.onclick = () => void (async () => { await this.plugin.store.updateNode(node.id, { pinned: true }); await this.render(); this.plugin.refreshPanels(); })();
      const archive = actions.createEl("button", { text: "归档", cls: "mod-warning" }); archive.onclick = () => void (async () => { await this.plugin.store.archiveNode(node.id, true); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
}

class RemoveAgentModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: DetectedAgent, private done: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `移除 ${this.agent.name} 接入？` });
    this.contentEl.createEl("p", { text: "这会移除 agentNote 的长期提示词；不会删除该 agent 的其他 skill、配置或对话。" });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: `${this.agent.skillDir}/SKILL.md` });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("确认移除").setDestructive().onClick(async () => {
        await this.plugin.disableAgent(this.agent);
        await this.done(); this.close();
      }));
  }
}

class ManualInstallModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "手动接入任意 agent" });
    this.contentEl.createEl("p", { text: "复制下面的任务给目标 agent。它会自行识别自己的 skill 或长期指令机制、验证本地服务并完成安装。" });
    const prompt = renderManualInstallPrompt({ port: this.plugin.server?.port ?? this.plugin.settings.port });
    const text = this.contentEl.createEl("textarea", { cls: "agentnote-manual-prompt" });
    text.value = prompt; text.readOnly = true;
    new Setting(this.contentEl).addButton((button) => button.setButtonText("复制安装任务").setCta().onClick(async () => {
      await navigator.clipboard.writeText(prompt); new Notice("已复制手动安装任务。");
    })).addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
  }
}

class AgentPromptModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: DetectedAgent, private done: () => Promise<void>) { super(app); }
  onOpen(): void {
    const profile = this.plugin.profile(this.agent.id);
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: `${this.agent.name} 的提示词` });
    this.contentEl.createEl("p", { text: "基础提示词会教 agent 识别“写到 Obsidian / agent 笔记 / 笔记里”并调用本地服务。这里填写该 agent 专属的附加要求。" });
    let instructions = profile.instructions;
    new Setting(this.contentEl).setName("附加要求").addTextArea((input) => { input.setValue(instructions); input.inputEl.addClass("agentnote-full-width"); input.onChange((value) => instructions = value); });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("预览基础提示词").onClick(() => {
      const existing = this.contentEl.querySelector(".agentnote-prompt-preview");
      if (existing) existing.remove();
      this.contentEl.createEl("pre", { cls: "agentnote-prompt-preview", text: renderSkillMd({ port: this.plugin.server?.port ?? this.plugin.settings.port, instructions }) });
    }));
    new Setting(this.contentEl).addButton((button) => button.setButtonText("保存并更新安装").setCta().onClick(async () => {
      await this.plugin.saveProfile(this.agent.id, { enabled: true, instructions });
      await this.plugin.installAgent(this.agent);
      await this.done(); this.close();
    }));
  }
}
