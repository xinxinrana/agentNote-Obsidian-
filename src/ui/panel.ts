import { App, ItemView, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type AgentNotePlugin from "../main";
import { renderManualInstallPrompt, renderSkillMd, type DetectedAgent } from "../core/skill";
import claudeCodeIcon from "../assets/agents/claude-code.png";
import codexIcon from "../assets/agents/codex.png";
import workbuddyIcon from "../assets/agents/workbuddy.png";
import { toBlob } from "html-to-image";
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
    if (event.type === "node-created") return `创建「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-updated") return `更新「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-archived") return `归档「${event.title ?? "未命名资料"}」`;
    if (event.type === "node-restored") return `恢复「${event.title ?? "未命名资料"}」`;
    if (event.type === "share-created") return `分享「${event.title ?? "资料"}」`;
    return `读取「${event.title ?? "分享资料"}」`;
  }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private async renderDashboard(): Promise<void> {
    const insights = await this.plugin.store.getDashboardInsights();
    const dashboard = this.contentEl.createDiv({ cls: "agentnote-dashboard" });
    const overview = dashboard.createDiv({ cls: "agentnote-dashboard-hero" });
    overview.createEl("span", { cls: "agentnote-eyebrow", text: "本地知识洞察" });
    overview.createEl("h4", { text: "知识正在持续进入工作流" });
    overview.createEl("p", { text: insights.summary.weekActivityCount ? `本周完成 ${insights.summary.weekActivityCount} 次有效操作：新建 ${insights.summary.weekCreated}、更新 ${insights.summary.weekUpdated}、分享 ${insights.summary.weekSharesCreated}、复用 ${insights.summary.weekResolves}。` : "新建、维护、分享或复用资料后，这里会记录完整的知识活动。" });
    const stats = overview.createDiv({ cls: "agentnote-metric-strip" });
    for (const [value, label] of [[insights.summary.weekActivityScore, "知识活跃分"], [insights.summary.weekUpdated, "本周更新"], [insights.summary.weekResolves, "本周复用"]] as const) {
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

type InsightTab = "overview" | "week" | "month" | "agents" | "timeline" | "archive";
type TimelineFilter = "all" | "created" | "used" | "changed";

class InsightsModal extends Modal {
  private tab: InsightTab = "overview";
  private timelineFilter: TimelineFilter = "all";
  private bulkUndoIds: string[] | null = null;
  private privateView = false;
  constructor(app: App, private plugin: AgentNotePlugin) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-insights-modal"); void this.render(); }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private dateText(iso: string): string { return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }); }
  private displayTitle(title: string): string { return this.privateView ? "已匿名资料" : title; }
  private activeDays(trend: { count: number }[]): number { return trend.filter((point) => point.count > 0).length; }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return `创建「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-updated") return `更新「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-archived") return `归档「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "node-restored") return `恢复「${this.displayTitle(event.title ?? "未命名资料")}」`;
    if (event.type === "share-created") return `分享「${event.title ?? "资料"}」`;
    return `读取「${event.title ?? "分享资料"}」`;
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
    share.onclick = () => new InsightShareModal(this.app, insights, agents.length, this.privateView).open();
    const tabs = this.contentEl.createDiv({ cls: "agentnote-insight-tabs" });
    for (const [tab, label] of [["overview", "档案"], ["week", "本周"], ["month", "开始以来"], ["agents", "Agent"], ["timeline", "时间线"], ["archive", "整理"]] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.tab === tab ? "is-active" : "" });
      button.onclick = () => { this.tab = tab; void this.render(); };
    }
    const body = this.contentEl.createDiv({ cls: "agentnote-modal-body" });
    if (this.tab === "overview") this.renderOverview(body, insights, agents);
    if (this.tab === "week") this.renderPeriod(body, { eyebrow: "WEEKLY REVIEW", title: "本周知识活跃报告", description: "新建、更新、分享与复用共同构成真实的知识工作节奏。", trendTitle: "每日知识活跃度", rankingTitle: "本周最常复用的资料" }, [[insights.summary.weekActivityScore, "知识活跃分"], [insights.summary.weekCreated, "新建资料"], [insights.summary.weekUpdated, "更新资料"], [insights.summary.weekResolves, "资料复用"]], insights.weekly, insights.weeklyTrend, "weekly");
    if (this.tab === "month") this.renderPeriod(body, { eyebrow: "ALL-TIME CONTRIBUTIONS", title: "开始以来的知识贡献", description: `从 ${this.dateText(insights.startedAt)} 的第一条记录开始，持续回看本地知识如何被创建、维护、分享与复用。`, trendTitle: "知识贡献", rankingTitle: "开始以来高价值资料" }, [[insights.allTimeTrend.filter((point) => point.count > 0).length, "活跃天数"], [insights.summary.allTimeActivityScore, "知识活跃分"], [insights.allTime.reduce((total, entry) => total + entry.reads, 0), "累计复用"], [insights.allTime.length, "高价值资料"]], insights.allTime, insights.allTimeTrend, "contributions");
    if (this.tab === "agents") this.renderAgents(body, agents);
    if (this.tab === "timeline") this.renderTimeline(body, insights);
    if (this.tab === "archive") this.renderArchive(body, insights);
  }
  private renderOverview(parent: HTMLElement, insights: DashboardInsights, agents: Awaited<ReturnType<AgentNotePlugin["store"]["getAgentInsights"]>>): void {
    const activeDays = this.activeDays(insights.weeklyTrend);
    const profile = parent.createDiv({ cls: "agentnote-profile-card" });
    const summary = profile.createDiv({ cls: "agentnote-profile-summary" });
    summary.createEl("span", { cls: "agentnote-profile-label", text: "近 7 天成果" });
    summary.createEl("strong", { text: `${insights.summary.weekActivityScore} 知识活跃分` });
    summary.createEl("p", { text: insights.summary.weekActivityCount ? `新建 ${insights.summary.weekCreated} · 更新 ${insights.summary.weekUpdated} · 分享 ${insights.summary.weekSharesCreated} · 复用 ${insights.summary.weekResolves}` : "开始新建、维护、分享或复用资料后，这里会记录完整的知识工作成果。" });
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
    heading.createEl("h3", { text: "本周高价值资料" });
    heading.createEl("span", { text: "按实际复用次数排序" });
    if (!insights.weekly.length) highlights.createEl("p", { cls: "agentnote-empty-copy", text: "资料被 agent 读取后，会在这里形成你的复用排行榜。" });
    else {
      const cards = highlights.createDiv({ cls: "agentnote-profile-note-list" });
      for (const [index, entry] of insights.weekly.entries()) {
        const card = cards.createDiv({ cls: "agentnote-profile-note" });
        card.createEl("span", { cls: "agentnote-profile-rank", text: String(index + 1).padStart(2, "0") });
        const detail = card.createDiv(); detail.createEl("strong", { text: this.displayTitle(entry.node.title) }); detail.createEl("small", { text: entry.reason });
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
    const trendHeading = trendSection.createDiv({ cls: "agentnote-section-heading" }); trendHeading.createEl("h3", { text: header.trendTitle }); if (mode === "weekly") trendHeading.createEl("span", { text: "新建 1 分 · 更新 2 分 · 分享 0.5 分 · 复用 1.5 分" });
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
      const row = card.createDiv({ cls: "agentnote-value-title" }); row.createEl("strong", { text: this.displayTitle(entry.node.title) });
      if (entry.node.pinned) row.createEl("span", { cls: "agentnote-pin-badge", text: "已保护", attr: { title: "这条资料不会出现在“整理”中的归档建议里。" } });
      card.createEl("p", { text: entry.reason });
      if (entry.lastRead) card.createEl("small", { text: `最近使用：${this.timeText(entry.lastRead)}` });
      const pin = card.createEl("button", { text: entry.node.pinned ? "取消保护" : "保护不归档", attr: { title: entry.node.pinned ? "允许这条资料再次进入归档建议。" : "保护后，这条资料不会出现在“整理”中的归档建议里；不会修改内容或分享地址。" } });
      pin.onclick = () => void (async () => { pin.disabled = true; const pinned = !entry.node.pinned; await this.plugin.store.updateNode(entry.node.id, { pinned }); new Notice(pinned ? `已保护「${entry.node.title}」：它不会进入归档建议。` : `已取消保护「${entry.node.title}」。`); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
  private renderContributionGraph(parent: HTMLElement, trend: { label: string; count: number }[], max: number): void {
    const weeks = Math.ceil(trend.length / 7);
    const chart = parent.createDiv({ cls: "agentnote-contribution-chart" });
    const weekdays = chart.createDiv({ cls: "agentnote-contribution-weekdays" });
    for (const label of ["日", "", "二", "", "四", "", "六"]) weekdays.createEl("span", { text: label });
    const calendar = chart.createDiv({ cls: "agentnote-contribution-calendar" });
    calendar.setCssProps({ "--agentnote-contribution-weeks": String(weeks), "--agentnote-contribution-width": `${weeks * 17}px` });
    const months = calendar.createDiv({ cls: "agentnote-contribution-months" });
    const grid = calendar.createDiv({ cls: "agentnote-contribution-grid" });
    for (const [index, point] of trend.entries()) {
      const date = new Date(`${point.label}T00:00:00`);
      if (index === 0 || date.getDate() === 1) {
        const label = months.createEl("span", { text: `${date.getMonth() + 1}月` });
        label.setCssProps({ "--agentnote-month-offset": `${Math.floor(index / 7) * 17}px` });
      }
      const cell = grid.createEl("span", { cls: `agentnote-contribution-cell${point.count ? " is-active" : ""}`, attr: { "aria-label": `${point.label}：${point.count} 知识活跃分` } });
      if (point.count) cell.setCssProps({ "--agentnote-activity-strength": `${Math.round((0.18 + point.count / max * 0.58) * 100)}%` });
    }
  }
  private renderTimeline(parent: HTMLElement, insights: DashboardInsights): void {
    const agents = new Set(insights.timeline.map((event) => event.actor?.name ?? event.actor?.id).filter(Boolean));
    this.renderTabHero(parent, "ACTIVITY LOG", "协作时间线", "用连续活动回看资料何时被创建、调用、更新和整理。", [[insights.timeline.length, "记录活动"], [agents.size, "参与 agent"], [insights.summary.weekResolves, "本周读取"]]);
    const filters = parent.createDiv({ cls: "agentnote-timeline-filters" });
    for (const [filter, label] of [["all", "全部"], ["created", "创建"], ["used", "使用"], ["changed", "变更"]] as const) {
      const button = filters.createEl("button", { text: label, cls: this.timelineFilter === filter ? "is-active" : "" });
      button.onclick = () => { this.timelineFilter = filter; void this.render(); };
    }
    const visible = insights.timeline.filter((event) => this.timelineFilter === "all" || (this.timelineFilter === "created" && event.type === "node-created") || (this.timelineFilter === "used" && ["share-created", "share-resolved"].includes(event.type)) || (this.timelineFilter === "changed" && ["node-updated", "node-archived", "node-restored"].includes(event.type)));
    if (!visible.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: "还没有符合条件的活动。换一个筛选条件，或开始一次新的资料协作。" }); return; }
    const list = parent.createEl("ul", { cls: "agentnote-timeline" });
    for (const event of visible) {
      const item = list.createEl("li");
      const detail = item.createDiv();
      const title = detail.createDiv({ cls: "agentnote-timeline-title" }); title.createEl("strong", { text: this.activityText(event) }); title.createEl("span", { cls: `agentnote-event-chip is-${event.type}`, text: event.type === "share-resolved" ? "使用" : event.type === "share-created" ? "分享" : event.type === "node-created" ? "创建" : event.type === "node-updated" ? "更新" : event.type === "node-archived" ? "归档" : "恢复" });
      detail.createEl("span", { text: [event.actor?.name ?? event.actor?.id ?? "未申报 agent", event.actor?.sessionTitle, event.targetKind === "folder" ? "文件夹" : event.targetKind === "node" ? "笔记" : "文件"].filter(Boolean).join(" · ") });
      item.createEl("time", { text: this.timeText(event.at) });
    }
  }
  private renderArchive(parent: HTMLElement, insights: DashboardInsights): void {
    this.renderTabHero(parent, "KNOWLEDGE HYGIENE", "资料整理建议", insights.archiveCandidates.length ? "这些资料已沉睡一段时间；整理它们能让下一次检索保持轻快。" : "你的资料库目前很整洁，没有需要优先归档的内容。", [[insights.archiveCandidates.length, "待整理资料"], [insights.summary.monthResolves, "本月协作"], [insights.monthly.length, "活跃资料"]]);
    const heading = parent.createDiv({ cls: "agentnote-section-heading agentnote-archive-heading" }); heading.createEl("h3", { text: insights.archiveCandidates.length ? "建议处理的资料" : "整理状态良好" });
    if (insights.archiveCandidates.length) {
      const all = heading.createEl("button", { text: `归档全部建议（${insights.archiveCandidates.length}）`, cls: "mod-warning" });
      all.onclick = () => void (async () => { all.disabled = true; const ids = insights.archiveCandidates.map((node) => node.id); try { await this.plugin.store.archiveNodes(ids, true); this.bulkUndoIds = ids; new Notice(`已归档 ${ids.length} 条建议笔记。`); await this.render(); this.plugin.refreshPanels(); } catch (error) { new Notice(`归档失败：${(error as Error).message}`); all.disabled = false; } })();
    }
    if (this.bulkUndoIds?.length) {
      const undo = parent.createDiv({ cls: "agentnote-undo" }); undo.createSpan({ text: `刚刚归档了 ${this.bulkUndoIds.length} 条笔记。` });
      const button = undo.createEl("button", { text: "撤销" }); button.onclick = () => void (async () => { await this.plugin.store.archiveNodes(this.bulkUndoIds!, false); this.bulkUndoIds = null; await this.render(); this.plugin.refreshPanels(); })();
    }
    if (!insights.archiveCandidates.length) { parent.createEl("p", { cls: "agentnote-empty-copy agentnote-polished-empty", text: "没有需要整理的低使用笔记。已保护资料不会被推荐归档。" }); return; }
    const list = parent.createDiv({ cls: "agentnote-archive-list" });
    for (const node of insights.archiveCandidates) {
      const card = list.createDiv({ cls: "agentnote-archive-card" }); card.createEl("strong", { text: node.title }); card.createEl("span", { text: "创建满 30 天，未被读取，且近 30 天未更新。" });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const keep = actions.createEl("button", { text: "保护，不归档", attr: { title: "保护后，这条资料不会再出现在归档建议里；不会修改内容或分享地址。" } }); keep.onclick = () => void (async () => { await this.plugin.store.updateNode(node.id, { pinned: true }); new Notice(`已保护「${node.title}」：它不会进入归档建议。`); await this.render(); this.plugin.refreshPanels(); })();
      const archive = actions.createEl("button", { text: "归档", cls: "mod-warning" }); archive.onclick = () => void (async () => { await this.plugin.store.archiveNode(node.id, true); await this.render(); this.plugin.refreshPanels(); })();
    }
  }
}

class InsightShareModal extends Modal {
  private imageBlob: Blob | null = null;
  private imageUrl: string | null = null;
  constructor(app: App, private insights: DashboardInsights, private agentCount: number, private privateView: boolean) { super(app); }
  onOpen(): void { this.modalEl.addClass("agentnote-share-modal"); void this.render(); }
  onClose(): void { if (this.imageUrl) URL.revokeObjectURL(this.imageUrl); }
  private activeDays(): number { return this.insights.weeklyTrend.filter((point) => point.count > 0).length; }
  private titleForShare(): string { return this.privateView ? "已匿名资料" : this.insights.weekly[0]?.node.title ?? "等待第一条资料被复用"; }
  private renderShareCard(parent: HTMLElement): void {
    const activeDays = this.activeDays();
    const max = Math.max(1, ...this.insights.weeklyTrend.map((point) => point.count));
    parent.createEl("span", { cls: "agentnote-share-brand", text: "agentNote · Local knowledge profile" });
    parent.createEl("h2", { text: "我的知识工作档案" });
    parent.createEl("p", { cls: "agentnote-share-subtitle", text: "让本地资料在每一次 AI 协作中持续发挥价值。" });
    const metrics = parent.createDiv({ cls: "agentnote-share-metrics" });
    for (const [value, label] of [[this.insights.summary.weekResolves, "资料协作"], [this.insights.summary.weekUsedNotes, "投入资料"], [activeDays, "活跃天数"]] as const) {
      const metric = metrics.createDiv(); metric.createEl("strong", { text: String(value) }); metric.createEl("span", { text: label });
    }
    const rhythm = parent.createDiv({ cls: "agentnote-share-rhythm" });
    const rhythmHeading = rhythm.createDiv(); rhythmHeading.createEl("strong", { text: "本周工作节奏" }); rhythmHeading.createEl("span", { text: `${this.agentCount} 个 agent 留下协作轨迹` });
    const days = rhythm.createDiv({ cls: "agentnote-share-days" });
    for (const point of this.insights.weeklyTrend) {
      const day = days.createDiv({ cls: `agentnote-share-day${point.count ? " is-active" : ""}` });
      if (point.count) day.setCssProps({ "--agentnote-activity-strength": `${Math.round((0.22 + point.count / max * 0.5) * 100)}%` });
      day.createEl("strong", { text: point.label }); day.createEl("span", { text: String(point.count) });
    }
    const top = parent.createDiv({ cls: "agentnote-share-top-note" });
    top.createEl("span", { text: "本周高价值资料" });
    top.createEl("strong", { text: this.titleForShare() });
    top.createEl("small", { text: this.insights.weekly[0] ? `被复用 ${this.insights.weekly[0].reads} 次` : "从一次分享开始建立可复用上下文" });
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

class RemoveAgentModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin, private agent: DetectedAgent, private done: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `移除 ${this.agent.name} 接入？` });
    this.contentEl.createEl("p", { text: "这会移除 agentNote 的长期提示词；不会删除该 agent 的其他 skill、配置或对话。" });
    this.contentEl.createEl("code", { cls: "agentnote-skill-path", text: `${this.agent.skillDir}/SKILL.md` });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => {
        button.buttonEl.addClass("mod-warning");
        button.setButtonText("确认移除").onClick(async () => {
          await this.plugin.disableAgent(this.agent);
          await this.done(); this.close();
        });
      });
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
