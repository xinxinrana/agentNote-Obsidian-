import { App, ItemView, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type AgentNotePlugin from "../main";
import { renderManualInstallPrompt, renderSkillMd, type DetectedAgent } from "../core/skill";

export const AGENTNOTE_VIEW = "agentnote-view";

export class AgentNoteView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: AgentNotePlugin) { super(leaf); }
  getViewType(): string { return AGENTNOTE_VIEW; }
  getDisplayText(): string { return "agentNote 接入台"; }
  getIcon(): string { return "bot"; }
  async onOpen(): Promise<void> { await this.refresh(); }

  async refresh(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass("agentnote-panel");
    this.contentEl.createEl("h3", { text: "agentNote 接入台" });
    this.renderServer();
    this.renderAgents(this.plugin.detectedAgents());
    await this.renderNotes();
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
    section.createEl("h4", { text: "已识别的 agent" });
    const manual = section.createEl("button", { text: "手动接入任意 agent" });
    manual.onclick = () => new ManualInstallModal(this.app, this.plugin).open();
    if (!agents.length) { section.createEl("p", { text: "尚未识别到内置 agent。可使用上方“手动接入任意 agent”。" }); return; }
    for (const agent of agents) {
      const profile = this.plugin.profile(agent.id);
      const card = section.createDiv({ cls: "agentnote-agent-card" });
      card.createEl("strong", { text: agent.name });
      card.createEl("div", { cls: "agentnote-node-meta", text: agent.installed && profile.enabled ? "已接入" : "未接入" });
      card.createEl("div", { cls: "agentnote-node-meta", text: agent.skillDir });
      const actions = card.createDiv({ cls: "agentnote-node-actions" });
      const install = actions.createEl("button", { text: agent.installed ? "更新提示词" : "安装提示词", cls: "mod-cta" });
      install.onclick = () => void this.plugin.installAgent(agent);
      const edit = actions.createEl("button", { text: "管理提示词" });
      edit.onclick = () => new AgentPromptModal(this.app, this.plugin, agent, () => this.refresh()).open();
      if (agent.installed) {
        const disable = actions.createEl("button", { text: "移除接入" });
        disable.onclick = () => void this.plugin.disableAgent(agent);
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
