/**
 * agentNote sidebar panel — the GUI face of the plugin.
 *
 * Pure presentation: every action delegates to the same VaultStore that the
 * agent HTTP API uses, so GUI and agent always see one consistent state.
 */

import { App, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import type AgentNotePlugin from "../main";
import { AgentNode, Group, GroupsData, Share, qualityWarnings, shareTarget } from "../core/types";

export const AGENTNOTE_VIEW = "agentnote-view";

const TYPE_ICON: Record<string, string> = { snippet: "📝", file: "📄", folder: "📁" };

interface PanelState {
  q: string;
  groupId: string | null;
}

export class AgentNoteView extends ItemView {
  private state: PanelState = { q: "", groupId: null };

  constructor(leaf: WorkspaceLeaf, private plugin: AgentNotePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AGENTNOTE_VIEW;
  }
  getDisplayText(): string {
    return "agentNote";
  }
  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("agentnote-panel");

    const store = this.plugin.store;
    const [nodes, groupsData, shares] = await Promise.all([
      store.listNodes({ q: this.state.q || undefined }),
      store.listGroups(),
      store.listShares(),
    ]);

    this.renderToolbar(root);
    this.renderNodes(root, nodes, groupsData, shares);
    this.renderGroups(root, groupsData, nodes);
    this.renderShares(root, shares, nodes);
    this.renderFooter(root);
  }

  // ---------- toolbar ----------

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "agentnote-toolbar" });
    const search = bar.createEl("input", {
      cls: "agentnote-search",
      attr: { placeholder: "搜索标题 / 内容 / 标签…", type: "search" },
    });
    search.value = this.state.q;
    let timer: number | null = null;
    search.oninput = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        this.state.q = search.value.trim();
        this.refresh();
      }, 250);
    };
    const addBtn = bar.createEl("button", { text: "＋ 新建", cls: "mod-cta" });
    addBtn.onclick = () => this.plugin.openCreateNodeModal();
  }

  // ---------- nodes ----------

  private renderNodes(
    root: HTMLElement,
    nodes: AgentNode[],
    groupsData: GroupsData,
    shares: Share[]
  ): void {
    let shown = nodes;
    if (this.state.groupId) {
      shown = nodes.filter((n) => (groupsData.membership[n.id] ?? []).includes(this.state.groupId!));
    }
    const section = root.createDiv({ cls: "agentnote-section" });
    const header = section.createEl("h4", { text: `节点 (${shown.length})` });
    if (this.state.groupId) {
      const g = groupsData.groups.find((x) => x.id === this.state.groupId);
      header.createEl("span", { cls: "agentnote-filter-chip", text: ` 分组: ${g?.name ?? "?"} ✕` })
        .onclick = () => {
        this.state.groupId = null;
        this.refresh();
      };
    }
    if (shown.length === 0) {
      section.createDiv({ cls: "agentnote-empty", text: "还没有节点。点「＋ 新建」写第一条记忆。" });
      return;
    }
    for (const node of shown) {
      const row = section.createDiv({ cls: "agentnote-node" });
      const warnings = qualityWarnings(node);
      const title = row.createDiv({ cls: "agentnote-node-title" });
      title.createEl("span", { text: `${TYPE_ICON[node.type] ?? "📝"} ${node.title}` });
      if (warnings.length > 0) title.createEl("span", { cls: "agentnote-badge-warn", text: "⚠" });
      title.onclick = () => this.openNodeFile(node.id);

      const meta = row.createDiv({ cls: "agentnote-node-meta" });
      const shareCount = shares.filter((s) => {
        const t = shareTarget(s);
        return !s.revoked && t.kind === "node" && t.nodeId === node.id;
      }).length;
      meta.setText(
        `${node.source}${node.tags.length ? " · " + node.tags.map((t) => "#" + t).join(" ") : ""}${shareCount ? ` · ${shareCount} 个活引用` : ""}`
      );

      const actions = row.createDiv({ cls: "agentnote-node-actions" });
      this.actionBtn(actions, "🔗", "创建活引用并复制 HTTP 链接（其他 agent 直接 GET 即可读到内容）", async () => {
        const share = await this.plugin.store.createShare(node.id);
        await navigator.clipboard.writeText(this.shareUrl(share.id));
        new Notice(`已复制分享链接，发给任何 agent 都能直接访问:\n${this.shareUrl(share.id)}`);
        await this.refresh();
      });
      this.actionBtn(actions, "🏷", "指派分组", () => {
        new NodeGroupsModal(this.app, this.plugin, node, async () => this.refresh()).open();
      });
      if (node.type !== "snippet") {
        this.actionBtn(actions, "📸", "对磁盘目标做只读快照", async () => {
          try {
            const rec = await this.plugin.store.createSnapshot(node.id);
            new Notice(`快照已保存到 ${rec.dir}`);
          } catch (e) {
            new Notice(`agentNote: ${(e as Error).message}`);
          }
        });
      }
    }
  }

  // ---------- groups ----------

  private renderGroups(root: HTMLElement, data: GroupsData, nodes: AgentNode[]): void {
    const section = root.createDiv({ cls: "agentnote-section" });
    const header = section.createEl("h4", { text: "分组" });
    const addBtn = header.createEl("button", { text: "＋", cls: "agentnote-mini-btn" });
    addBtn.onclick = () => new CreateGroupModal(this.app, this.plugin, data, async () => this.refresh()).open();

    if (data.groups.length === 0) {
      section.createDiv({ cls: "agentnote-empty", text: "暂无分组" });
      return;
    }
    const countIn = (gid: string) =>
      Object.values(data.membership).filter((gs) => gs.includes(gid)).length;
    const renderLevel = (parentId: string | null, container: HTMLElement, depth: number) => {
      for (const g of data.groups.filter((x) => x.parentId === parentId)) {
        const row = container.createDiv({ cls: "agentnote-group" });
        row.style.paddingLeft = `${depth * 14}px`;
        const label = row.createEl("span", {
          cls: "agentnote-group-name",
          text: `▸ ${g.name} (${countIn(g.id)})`,
        });
        label.onclick = () => {
          this.state.groupId = this.state.groupId === g.id ? null : g.id;
          this.refresh();
        };
        const del = row.createEl("button", { text: "✕", cls: "agentnote-mini-btn" });
        del.title = "删除分组（含子组，不影响节点）";
        del.onclick = async () => {
          await this.plugin.store.deleteGroup(g.id);
          if (this.state.groupId === g.id) this.state.groupId = null;
          await this.refresh();
        };
        renderLevel(g.id, container, depth + 1);
      }
    };
    renderLevel(null, section, 0);
  }

  // ---------- shares ----------

  private renderShares(root: HTMLElement, shares: Share[], nodes: AgentNode[]): void {
    const section = root.createDiv({ cls: "agentnote-section" });
    section.createEl("h4", { text: `分享引用 (${shares.length})` });
    if (shares.length === 0) {
      section.createDiv({
        cls: "agentnote-empty",
        text: "选中文字 → 右键分享；或在文件列表右键任意文件/文件夹 → agentNote: 分享",
      });
      return;
    }
    const titleOf = (id: string) => nodes.find((n) => n.id === id)?.title ?? id;
    const labelOf = (s: Share): string => {
      const t = shareTarget(s);
      if (t.kind === "node") return titleOf(t.nodeId);
      return `${TYPE_ICON[t.kind]} ${t.path}`;
    };
    for (const s of [...shares].reverse()) {
      const row = section.createDiv({ cls: "agentnote-share-row" });
      const label = row.createEl("span", {
        cls: s.revoked ? "agentnote-share-revoked" : "agentnote-share-live",
        text: `${s.id}${s.selection ? "（选段）" : ""} → ${labelOf(s)}`,
      });
      label.title = s.revoked ? "已吊销" : `活引用，GET 即返回最新内容:\n${this.shareUrl(s.id)}`;
      if (!s.revoked) {
        this.actionBtn(row, "📋", "复制 HTTP 链接（发给其他 agent，直接访问到内容）", async () => {
          await navigator.clipboard.writeText(this.shareUrl(s.id));
          new Notice(`已复制分享链接:\n${this.shareUrl(s.id)}`);
        });
        this.actionBtn(row, "🚫", "吊销（链接立即失效，返回 410）", async () => {
          await this.plugin.store.revokeShare(s.id);
          new Notice(`已吊销 ${s.id}`);
          await this.refresh();
        });
      }
    }
  }

  // ---------- footer ----------

  private renderFooter(root: HTMLElement): void {
    const footer = root.createDiv({ cls: "agentnote-footer" });
    const port = this.plugin.server?.port ?? this.plugin.settings.port;
    const status = footer.createDiv({
      cls: "agentnote-server-status",
      text: this.plugin.server ? `🟢 agent API: http://127.0.0.1:${port}` : "🔴 agent API 未运行",
    });
    status.onclick = async () => {
      if (this.plugin.server) await this.plugin.stopServer();
      else await this.plugin.startServer();
      await this.refresh();
    };
    const promptBtn = footer.createEl("button", {
      text: "📄 复制 agent 接入说明",
      cls: "agentnote-prompt-btn",
    });
    promptBtn.title = "生成给 agent 的系统提示（含 API 用法与质量红线），复制后粘贴给你的 agent";
    promptBtn.onclick = () => this.plugin.exportAgentPrompt();
    const skillBtn = footer.createEl("button", {
      text: "🧩 为本地 agent 安装 skill",
      cls: "agentnote-prompt-btn",
    });
    skillBtn.title = "自动识别本机的 agent（Claude Code / Codex / WorkBuddy…），把 SKILL.md 写进它们的 skill 目录，装好后 agent 自动会用本记忆层";
    skillBtn.onclick = () => this.plugin.openInstallSkillModal();
  }

  // ---------- helpers ----------

  /** The URL another agent can GET directly to read a share's live content. */
  private shareUrl(shareId: string): string {
    const port = this.plugin.server?.port ?? this.plugin.settings.port;
    return `http://127.0.0.1:${port}/api/shares/${shareId}/resolve`;
  }

  private actionBtn(
    container: HTMLElement,
    icon: string,
    tooltip: string,
    onClick: () => void | Promise<void>
  ): void {
    const btn = container.createEl("button", { text: icon, cls: "agentnote-mini-btn" });
    btn.title = tooltip;
    btn.onclick = () => void onClick();
  }

  private async openNodeFile(nodeId: string): Promise<void> {
    try {
      const rel = await this.plugin.store.nodeFilePath(nodeId);
      const file = this.app.vault.getAbstractFileByPath(rel);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
        return;
      }
    } catch {
      // fall through to the notice
    }
    new Notice("agentNote: 找不到节点文件（可能被移动了）");
  }
}

/** Assign a node to groups (many-to-many) via checkboxes. */
class NodeGroupsModal extends Modal {
  constructor(
    app: App,
    private plugin: AgentNotePlugin,
    private node: AgentNode,
    private onChange: () => Promise<void>
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `分组 · ${this.node.title}` });
    const data = await this.plugin.store.listGroups();
    const current = new Set(data.membership[this.node.id] ?? []);
    if (data.groups.length === 0) {
      contentEl.createDiv({ cls: "agentnote-empty", text: "还没有分组，先在面板里创建。" });
      return;
    }
    const checked = new Set(current);
    for (const g of data.groups) {
      new Setting(contentEl).setName(g.name).addToggle((t) =>
        t.setValue(current.has(g.id)).onChange((v) => {
          if (v) checked.add(g.id);
          else checked.delete(g.id);
        })
      );
    }
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("保存").setCta().onClick(async () => {
        await this.plugin.store.setNodeGroups(this.node.id, [...checked]);
        new Notice("分组已更新");
        await this.onChange();
        this.close();
      })
    );
  }
}

/** Create a group, optionally under a parent. */
class CreateGroupModal extends Modal {
  constructor(
    app: App,
    private plugin: AgentNotePlugin,
    private data: GroupsData,
    private onChange: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "新建分组" });
    let name = "";
    let parentId: string | null = null;
    new Setting(contentEl).setName("名称").addText((t) => t.onChange((v) => (name = v)));
    new Setting(contentEl).setName("父分组").addDropdown((d) => {
      d.addOption("", "（无 — 顶层）");
      for (const g of this.data.groups) d.addOption(g.id, g.name);
      d.onChange((v) => (parentId = v || null));
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("创建").setCta().onClick(async () => {
        try {
          await this.plugin.store.createGroup(name, parentId);
          await this.onChange();
          this.close();
        } catch (e) {
          new Notice(`agentNote: ${(e as Error).message}`);
        }
      })
    );
  }
}
