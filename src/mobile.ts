import { ItemView, Plugin, TFile, WorkspaceLeaf, getLanguage } from "obsidian";
import { languageForPreference, locale, setLanguage, t } from "./i18n";
import { readMobileHistory } from "./core/mobileHistory";
import type { InsightEvent } from "./core/store";

const VIEW = "agentnote-mobile-history";
export default class MobileAgentNote extends Plugin {
  excludedFolders: string[] = [];
  async onload(): Promise<void> {
    const saved = await this.loadData().catch(() => null);
    setLanguage(languageForPreference(saved?.language === "zh" || saved?.language === "en" ? saved.language : "auto", getLanguage()));
    this.excludedFolders = Array.isArray(saved?.excludedFolders) ? saved.excludedFolders.filter((p: unknown): p is string => typeof p === "string") : [];
    this.registerView(VIEW, leaf => new MobileHistoryView(leaf, this));
    const open = async () => { const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW, active: true }); await this.app.workspace.revealLeaf(leaf); };
    this.addRibbonIcon("history", t("查看知识活动"), () => void open());
    this.addCommand({ id: "open-panel", name: t("查看知识活动"), callback: open });
  }
}
class MobileHistoryView extends ItemView {
  private generation = 0;
  private limit = 100;
  private query = "";
  constructor(leaf: WorkspaceLeaf, private plugin: MobileAgentNote) { super(leaf); }
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return t("知识活动"); }
  getIcon(): string { return "history"; }
  async onOpen(): Promise<void> { await this.render(); }
  async onClose(): Promise<void> { this.generation++; }
  private async render(): Promise<void> {
    const generation = ++this.generation;
    const report = await readMobileHistory(this.app.vault.adapter, this.plugin.excludedFolders);
    if (generation !== this.generation) return;
    this.contentEl.empty(); this.contentEl.addClass("agentnote-mobile");
    this.contentEl.createEl("h2", { text: "agentNote" });
    this.contentEl.createEl("p", { text: t("手机端只读看板 · 展示已同步的活动记录") });
    this.contentEl.createEl("button", { text: t("刷新") }).onclick = () => void this.render();
    if (report.issues.length) this.contentEl.createEl("p", { text: t("部分历史无法读取，已保留原文件：{0}", report.issues.join("、")), attr: { role: "status" } });
    const events = report.events.filter(event => !event.stateOnly);
    const weekStart = new Date(); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const now = Date.now();
    const week = events.filter(event => Date.parse(event.at) >= weekStart.getTime() && Date.parse(event.at) <= now);
    const stats = this.contentEl.createDiv({ cls: "agentnote-mobile-stats" });
    for (const [label, value] of [[t("本周活动次数"), week.length], [t("累计活动次数"), events.length], [t("协作 agent"), new Set(events.map(event => event.actor?.name).filter(Boolean)).size]] as const) {
      const card = stats.createDiv(); card.createEl("strong", { text: String(value) }); card.createDiv({ text: label });
    }
    this.contentEl.createEl("h3", { text: t("时间线") });
    const search = this.contentEl.createEl("input", { type: "search", value: this.query, attr: { placeholder: t("搜索资料名称"), "aria-label": t("搜索资料名称") } });
    const list = this.contentEl.createDiv();
    const currentPaths = new Map<string, string | null>();
    for (const event of [...report.events].reverse()) {
      const key = event.documentId || event.nodeId;
      if (key && event.path) currentPaths.set(key, event.type === "local-deleted" ? null : event.path);
    }
    const draw = () => {
      list.empty();
      const selected = events.filter(event => (event.title ?? event.path ?? "").toLowerCase().includes(this.query.toLowerCase()));
      if (!selected.length) list.createEl("p", { text: t("暂无活动记录") });
      for (const event of selected.slice(0, this.limit)) {
        const row = list.createDiv({ cls: "agentnote-mobile-row" });
        const key = event.documentId || event.nodeId;
        const filePath = key && currentPaths.has(key) ? currentPaths.get(key) : event.path;
        const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null;
        const title = event.title ?? event.path ?? t("未命名资料");
        if (file instanceof TFile && event.type !== "local-deleted") row.createEl("button", { text: title }).onclick = () => { void this.app.workspace.getLeaf("tab").openFile(file); };
        else row.createEl("strong", { text: title });
        row.createEl("small", { text: `${this.eventLabel(event)} · ${event.actor?.name ?? t("本地操作")} · ${new Date(event.at).toLocaleString(locale())}` });
      }
      if (selected.length > this.limit) list.createEl("button", { text: t("加载更多") }).onclick = () => { this.limit += 100; draw(); };
    };
    search.oninput = () => { this.query = search.value; this.limit = 100; draw(); }; draw();
  }
  private eventLabel(event: InsightEvent): string {
    if (["node-created", "local-created"].includes(event.type)) return t("新建");
    if (["share-resolved", "local-read"].includes(event.type)) return t("读取");
    if (event.type === "share-created") return t("分享");
    if (event.type === "local-deleted") return t("删除");
    if (event.type === "document-linked") return t("连接");
    if (["node-archived", "node-restored", "local-moved"].includes(event.type)) return t("整理");
    return t("更新");
  }
}
