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
  private bulkUndoIds: string[] | null = null;
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
    await this.renderNotes();
  }
  private activityText(event: InsightEvent): string {
    if (event.type === "node-created") return "新建了一条笔记";
    if (event.type === "node-updated") return "更新了一条笔记";
    if (event.type === "node-archived") return "归档了一条笔记";
    if (event.type === "node-restored") return "恢复了一条笔记";
    return event.targetKind === "node" ? "agent 读取了分享笔记" : `agent 读取了分享${event.targetKind === "folder" ? "文件夹" : "文件"}`;
  }
  private timeText(iso: string): string { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  private renderValueNotes(section: HTMLElement, title: string, notes: InsightNote[]): void {
    const header = section.createDiv({ cls: "agentnote-insight-heading" });
    header.createEl("h4", { text: title });
    if (!notes.length) { section.createEl("p", { text: "分享笔记被读取后，这里会显示它带来的复用价值。" }); return; }
    const cards = section.createDiv({ cls: "agentnote-value-cards" });
    for (const entry of notes) {
      const card = cards.createDiv({ cls: "agentnote-value-card" });
      const titleRow = card.createDiv({ cls: "agentnote-value-title" });
      titleRow.createEl("strong", { text: entry.node.title });
      if (entry.node.pinned) titleRow.createEl("span", { cls: "agentnote-pin-badge", text: "已固定" });
      card.createEl("p", { text: entry.reason });
      if (entry.lastRead) card.createEl("small", { text: `最近读取：${this.timeText(entry.lastRead)}` });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const pin = actions.createEl("button", { text: entry.node.pinned ? "取消固定" : "固定" });
      pin.onclick = () => void (async () => {
        pin.disabled = true;
        await this.plugin.store.updateNode(entry.node.id, { pinned: !entry.node.pinned });
        this.plugin.refreshPanels();
      })();
    }
  }
  private async renderDashboard(): Promise<void> {
    const insights = await this.plugin.store.getDashboardInsights();
    const dashboard = this.contentEl.createDiv({ cls: "agentnote-dashboard" });
    const overview = dashboard.createDiv({ cls: "agentnote-insight-overview" });
    overview.createEl("h4", { text: "你的知识正在工作" });
    overview.createEl("p", { text: `本周新增 ${insights.summary.weekCreated} 条资料；${insights.summary.weekUsedNotes} 条笔记经 ${insights.summary.weekResolves} 次链接解析进入 agent 工作流。` });
    const stats = overview.createDiv({ cls: "agentnote-insight-stats" });
    for (const [value, label] of [[insights.summary.weekCreated, "本周新增"], [insights.summary.weekResolves, "本周读取"], [insights.summary.monthResolves, "本月读取"]] as const) {
      const stat = stats.createDiv(); stat.createEl("strong", { text: String(value) }); stat.createEl("span", { text: label });
    }
    const grid = dashboard.createDiv({ cls: "agentnote-insight-grid" });
    const value = grid.createDiv({ cls: "agentnote-insight-section" });
    this.renderValueNotes(value, "本周最有价值", insights.weekly);
    this.renderValueNotes(value, "本月最有价值", insights.monthly);
    const activity = grid.createDiv({ cls: "agentnote-insight-section" });
    activity.createEl("h4", { text: "近期活动" });
    if (!insights.activities.length) activity.createEl("p", { text: "创建并分享资料给 agent 后，这里会留下它进入工作流的记录。" });
    else {
      const list = activity.createEl("ul", { cls: "agentnote-activity-list" });
      for (const event of insights.activities) {
        const item = list.createEl("li"); item.createEl("span", { text: this.activityText(event) }); item.createEl("time", { text: this.timeText(event.at) });
      }
    }
    this.renderArchiveRecommendations(dashboard, insights);
  }
  private renderArchiveRecommendations(dashboard: HTMLElement, insights: DashboardInsights): void {
    const section = dashboard.createDiv({ cls: "agentnote-archive-section" });
    const heading = section.createDiv({ cls: "agentnote-insight-heading" });
    heading.createEl("h4", { text: `建议归档 · ${insights.archiveCandidates.length}` });
    if (insights.archiveCandidates.length) {
      const archiveAll = heading.createEl("button", { text: `归档全部建议（${insights.archiveCandidates.length}）`, cls: "mod-warning" });
      archiveAll.onclick = () => void (async () => {
        archiveAll.disabled = true;
        const ids = insights.archiveCandidates.map((node) => node.id);
        try { await this.plugin.store.archiveNodes(ids, true); this.bulkUndoIds = ids; new Notice(`已归档 ${ids.length} 条建议笔记。`); this.plugin.refreshPanels(); }
        catch (error) { new Notice(`归档失败：${(error as Error).message}`); archiveAll.disabled = false; }
      })();
    }
    if (this.bulkUndoIds?.length) {
      const undo = section.createDiv({ cls: "agentnote-undo" });
      undo.createSpan({ text: `刚刚归档了 ${this.bulkUndoIds.length} 条笔记。` });
      const button = undo.createEl("button", { text: "撤销" });
      button.onclick = () => void (async () => { await this.plugin.store.archiveNodes(this.bulkUndoIds!, false); this.bulkUndoIds = null; this.plugin.refreshPanels(); })();
    }
    if (!insights.archiveCandidates.length) { section.createEl("p", { text: "没有低使用且陈旧的笔记。固定笔记不会被推荐归档。" }); return; }
    const list = section.createDiv({ cls: "agentnote-archive-list" });
    for (const node of insights.archiveCandidates.slice(0, 5)) {
      const card = list.createDiv({ cls: "agentnote-archive-card" });
      card.createEl("strong", { text: node.title });
      card.createEl("span", { text: "创建满 30 天，未被读取，且近 30 天未更新。" });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const keep = actions.createEl("button", { text: "固定并保留" });
      keep.onclick = () => void (async () => { await this.plugin.store.updateNode(node.id, { pinned: true }); this.plugin.refreshPanels(); })();
      const archive = actions.createEl("button", { text: "归档", cls: "mod-warning" });
      archive.onclick = () => void (async () => { await this.plugin.store.archiveNode(node.id, true); this.plugin.refreshPanels(); })();
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
    if (!agents.length) { section.createEl("p", { text: "尚未识别到内置 agent。可使用上方“手动接入任意 agent”。" }); return; }
    for (const agent of agents) {
      const profile = this.plugin.profile(agent.id);
      const card = section.createDiv({ cls: "agentnote-agent-card" });
      const header = card.createDiv({ cls: "agentnote-agent-header" });
      const icon = header.createEl("img", { cls: "agentnote-agent-icon", attr: { src: AGENT_ICONS[agent.id], alt: `${agent.name} 图标` } });
      icon.decoding = "async";
      const identity = header.createDiv();
      identity.createEl("strong", { text: agent.name });
      identity.createEl("div", { cls: `agentnote-agent-status ${agent.installed && profile.enabled ? "is-connected" : ""}`, text: agent.installed && profile.enabled ? "已接入" : "未接入" });
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
  private async renderNotes(): Promise<void> {
    const [active, archived] = await Promise.all([this.plugin.store.listNodes({ archived: false }), this.plugin.store.listNodes({ archived: true })]);
    const section = this.contentEl.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: `笔记 · 常用 ${active.length} / 归档 ${archived.length}` });
    section.createEl("p", { text: "笔记管理是辅助功能。agent 通过已安装的提示词理解“写到笔记里”。" });
    const create = section.createEl("button", { text: "新建笔记" });
    create.onclick = () => this.plugin.openCreateNoteModal();
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
      .addButton((button) => button.setButtonText("确认移除").setWarning().onClick(async () => {
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
    new Setting(this.contentEl).setName("附加要求").addTextArea((input) => { input.setValue(instructions); input.inputEl.style.width = "100%"; input.onChange((value) => instructions = value); });
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
