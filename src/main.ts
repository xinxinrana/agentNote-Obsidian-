/**
 * agentNote Obsidian plugin — UI layer.
 *
 * The plugin is a thin skin over the core engine (src/core/*): all durable
 * logic lives in VaultStore/AgentServer, which run on plain Node and are
 * covered by Obsidian-free e2e tests. This file only wires Obsidian
 * concepts (commands, modals, settings, markdown post-processing) to it.
 */

import * as os from "os";
import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { VaultStore } from "./core/store";
import { AgentServer } from "./core/server";
import { detectAgents, installSkill } from "./core/skill";
import { NodeType, emptyBoundary, qualityWarnings } from "./core/types";
import { parseNode, isNodeFile } from "./core/nodeFile";
import { AGENTNOTE_VIEW, AgentNoteView } from "./ui/panel";

interface AgentNoteSettings {
  port: number;
  autostartServer: boolean;
  /** Free-text user preferences appended to the exported agent prompt (FR-9). */
  agentPreferences: string;
}

const DEFAULT_SETTINGS: AgentNoteSettings = {
  port: 27182,
  autostartServer: true,
  agentPreferences: "",
};

export default class AgentNotePlugin extends Plugin {
  settings: AgentNoteSettings = DEFAULT_SETTINGS;
  store!: VaultStore;
  server: AgentServer | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("agentNote: 需要文件系统适配器（仅桌面端可用）。");
      return;
    }
    this.store = new VaultStore(adapter.getBasePath());
    const initInfo = await this.store.init();
    if (initInfo.migratedNodes > 0 || initInfo.legacyVersionsBackup) {
      new Notice(
        `agentNote: 已迁移 ${initInfo.migratedNodes} 个节点为标题文件名` +
          (initInfo.legacyVersionsBackup
            ? `；旧版本目录已移至 ${initInfo.legacyVersionsBackup}（历史交由 git 管理，可手动删除）`
            : ""),
        10000
      );
    }

    this.addSettingTab(new AgentNoteSettingTab(this.app, this));

    // GUI sidebar panel
    this.registerView(AGENTNOTE_VIEW, (leaf) => new AgentNoteView(leaf, this));

    this.addRibbonIcon("brain", "打开 agentNote 面板", () => {
      void this.activatePanel();
    });

    this.addCommand({
      id: "open-agentnote-panel",
      name: "打开 agentNote 面板",
      callback: () => this.activatePanel(),
    });

    // Refresh the panel when node files change on disk (manual edits included)
    let refreshTimer: number | null = null;
    const scheduleRefresh = (file: { path: string } | null) => {
      if (!file || !file.path.startsWith("agentNote/")) return;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => this.refreshPanels(), 400);
    };
    this.registerEvent(this.app.vault.on("modify", scheduleRefresh));
    this.registerEvent(this.app.vault.on("create", scheduleRefresh));
    this.registerEvent(this.app.vault.on("delete", scheduleRefresh));
    this.registerEvent(this.app.vault.on("rename", (file) => scheduleRefresh(file)));

    // Right-click a text selection → share it as a live reference (FR-5)
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item
            .setTitle("agentNote: 分享选中内容（复制 s-x 链接）")
            .setIcon("link")
            .onClick(() => this.shareSelection(editor))
        );
      })
    );

    // Right-click ANY file/folder in the explorer → share it (live, GETtable URL)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) =>
          item
            .setTitle("agentNote: 分享（复制 s-x 链接）")
            .setIcon("link")
            .onClick(() => this.sharePathAndCopy(file.path))
        );
      })
    );

    this.addCommand({
      id: "start-agent-server",
      name: "启动 agent API 服务",
      callback: () => this.startServer(),
    });
    this.addCommand({
      id: "stop-agent-server",
      name: "停止 agent API 服务",
      callback: () => this.stopServer(),
    });
    this.addCommand({
      id: "create-node",
      name: "新建记忆节点",
      callback: () => new CreateNodeModal(this.app, this).open(),
    });
    this.addCommand({
      id: "create-node-from-selection",
      name: "用选中内容新建记忆节点",
      editorCallback: (editor: Editor) => {
        const sel = editor.getSelection();
        new CreateNodeModal(this.app, this, sel).open();
      },
    });
    this.addCommand({
      id: "share-selection",
      name: "分享选中内容（复制 s-x 链接）",
      editorCallback: (editor: Editor) => this.shareSelection(editor),
    });
    this.addCommand({
      id: "share-current-note",
      name: "分享当前笔记（复制 s-x 链接）",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("agentNote: 没有打开的文件。");
          return;
        }
        void this.sharePathAndCopy(file.path);
      },
    });
    this.addCommand({
      id: "export-agent-prompt",
      name: "导出 agent 接入说明",
      callback: () => this.exportAgentPrompt(),
    });
    this.addCommand({
      id: "install-agent-skill",
      name: "为本地 agent 安装 skill",
      callback: () => this.openInstallSkillModal(),
    });
    this.addCommand({
      id: "snapshot-current-node",
      name: "快照当前文件/文件夹节点的磁盘目标",
      callback: () => this.snapshotCurrentNode(),
    });

    // FR-2/FR-5: render boundary info + resolve embedded s-x references in
    // reading view, and warn visibly when an agent-written node lacks
    // boundary fields (FR-8).
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      await this.decorateNodeFile(el, ctx);
      await this.resolveEmbeddedShares(el);
    });

    if (this.settings.autostartServer) await this.startServer(true);
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(AGENTNOTE_VIEW);
    await this.stopServer(true);
  }

  async activatePanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(AGENTNOTE_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: AGENTNOTE_VIEW, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(AGENTNOTE_VIEW)) {
      if (leaf.view instanceof AgentNoteView) void leaf.view.refresh();
    }
  }

  openCreateNodeModal(initialContent = ""): void {
    new CreateNodeModal(this.app, this, initialContent).open();
  }

  /** Open the modal that installs the agentNote skill for local agents. */
  openInstallSkillModal(): void {
    new InstallSkillModal(this.app, this).open();
  }

  async startServer(quiet = false): Promise<void> {
    if (this.server) {
      if (!quiet) new Notice(`agentNote API 已在端口 ${this.server.port} 运行`);
      return;
    }
    this.server = new AgentServer(this.store, { port: this.settings.port });
    try {
      const port = await this.server.start();
      if (!quiet) new Notice(`agentNote agent API 已启动: http://127.0.0.1:${port}`);
    } catch (e) {
      this.server = null;
      new Notice(`agentNote: API 服务启动失败: ${(e as Error).message}`);
    }
  }

  async stopServer(quiet = false): Promise<void> {
    if (!this.server) return;
    await this.server.stop();
    this.server = null;
    if (!quiet) new Notice("agentNote agent API 已停止。");
  }

  /** Extract the node id if the currently active file is an agentNote node. */
  private async currentNodeId(): Promise<string | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const raw = await this.app.vault.read(file);
    if (!isNodeFile(raw)) return null;
    try {
      return parseNode(raw).id;
    } catch {
      return null;
    }
  }

  private async shareSelection(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice("agentNote: 请先选中一段文字。");
      return;
    }
    try {
      const nodeId = await this.currentNodeId();
      let share;
      if (nodeId) {
        share = await this.store.createShare(nodeId, selection);
      } else {
        // Any vault note is shareable: fall back to a live file-selection share.
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("agentNote: 没有打开的文件。");
          return;
        }
        share = await this.store.createFileShare(file.path, selection);
      }
      // 不改动正文：链接进剪贴板，发给任何 agent 直接 GET 即得实时内容。
      const port = this.server?.port ?? this.settings.port;
      const url = `http://127.0.0.1:${port}/api/shares/${share.id}/resolve`;
      await navigator.clipboard.writeText(url);
      new Notice(`已复制分享链接（原文未动），发给任何 agent 都能直接访问:\n${url}`, 8000);
      await this.refreshPanels();
    } catch (e) {
      new Notice(`agentNote: ${(e as Error).message}`);
    }
  }

  /** Share any vault file/folder and copy its directly-GETtable URL. */
  private async sharePathAndCopy(relPath: string): Promise<void> {
    try {
      const share = await this.store.createPathShare(relPath);
      const port = this.server?.port ?? this.settings.port;
      const url = `http://127.0.0.1:${port}/api/shares/${share.id}/resolve`;
      await navigator.clipboard.writeText(url);
      new Notice(`已复制分享链接，发给任何 agent 都能直接访问:\n${url}`, 8000);
      await this.refreshPanels();
    } catch (e) {
      new Notice(`agentNote: ${(e as Error).message}`);
    }
  }

  /** FR-9: one-click, paste-ready integration prompt for agents. */
  async exportAgentPrompt(): Promise<void> {
    const port = this.server?.port ?? this.settings.port;
    const base = `http://127.0.0.1:${port}`;
    const prefs = this.settings.agentPreferences.trim();
    const prompt = `# agentNote —— 用户的显式记忆层

你可以通过本地 HTTP API（${base}，仅 localhost、无鉴权）访问 agentNote。就三件事：读、写、守规范。

## 一、规范（最重要）
- 你写入的每条记忆都必须带 boundary 三字段：background（这条记忆从哪来、为什么存在）、scenarios（什么情况下应该用它）、caveats（什么时候不该用 / 何时失效）。
- 写入时标 "source": "agent"。缺 boundary 的 agent 记忆会被显著标记为低质量，用户看得见。
- 不要盲改：改一条记忆前先 GET 它，尽量做窄更新。

## 二、读
- 搜索/列出节点：  GET  ${base}/api/nodes?tag=&q=&type=snippet|file|folder
- 读单条节点：      GET  ${base}/api/nodes/<id>          （含 boundary 和 warnings）
- 健康检查：        GET  ${base}/api/health

## 三、写
- 新建节点：        POST ${base}/api/nodes               {"type":"snippet","title":"...","content":"...","boundary":{"background":"...","scenarios":"...","caveats":"..."},"tags":[],"source":"agent"}
- 更新节点：        PUT  ${base}/api/nodes/<id>          {"content":"...","boundary":{...},"source":"agent"}

## 顺带一提
- 分享引用（s-x-...）是活的：链接 ${base}/api/shares/s-x-XXXXXXXXXXXX/resolve 可以直接 GET（加 ?raw=1 拿纯文本），读到的是当前最新内容。使用时再解析，别缓存。返回 410 表示用户已吊销或目标已删除——视为"用户收回了这段内容"。
- 分组（可选）：GET/POST ${base}/api/groups，PUT ${base}/api/nodes/<id>/groups {"groupIds":[...]}
${prefs ? `\n## 用户偏好\n${prefs}\n` : ""}`;
    await navigator.clipboard.writeText(prompt);
    new Notice("agentNote: agent 接入说明已复制到剪贴板。");
  }

  /** FR-7: snapshot the disk target of the active file/folder node. */
  private async snapshotCurrentNode(): Promise<void> {
    const nodeId = await this.currentNodeId();
    if (!nodeId) {
      new Notice("agentNote: 当前笔记不是 agentNote 节点。");
      return;
    }
    try {
      const rec = await this.store.createSnapshot(nodeId);
      new Notice(`agentNote: 快照已保存到 ${rec.dir}。`);
    } catch (e) {
      new Notice(`agentNote: ${(e as Error).message}`);
    }
  }

  /** FR-2/FR-8: boundary panel + missing-boundary banner above node files. */
  private async decorateNodeFile(
    el: HTMLElement,
    ctx: { sourcePath: string }
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const raw = await this.app.vault.cachedRead(file);
    if (!isNodeFile(raw)) return;
    let node;
    try {
      node = parseNode(raw);
    } catch {
      return;
    }
    const warnings = qualityWarnings(node);
    const box = el.createDiv({ cls: "agentnote-boundary-panel" });
    if (warnings.length > 0) {
      box.createDiv({ cls: "agentnote-warning", text: `⚠ ${warnings[0].message}` });
    }
    const b = node.boundary;
    box.createEl("div", { cls: "agentnote-boundary-row", text: `背景: ${b.background || "—"}` });
    box.createEl("div", {
      cls: "agentnote-boundary-row",
      text: `适用场景: ${b.scenarios || "—"}`,
    });
    box.createEl("div", {
      cls: "agentnote-boundary-row",
      text: `注意与失效: ${b.caveats || "—"}`,
    });
    box.createEl("div", {
      cls: "agentnote-boundary-meta",
      text: `agentNote 节点 ${node.id} · ${node.type} · 来源: ${node.source}`,
    });
    el.prepend(box);
  }

  /** FR-5: replace s-x-... tokens with the share's CURRENT content. */
  private async resolveEmbeddedShares(el: HTMLElement): Promise<void> {
    const pattern = /s-x-[0-9a-f]{12}/g;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let n = walker.nextNode();
    while (n) {
      if (pattern.test(n.nodeValue ?? "")) targets.push(n as Text);
      n = walker.nextNode();
    }
    for (const textNode of targets) {
      const text = textNode.nodeValue ?? "";
      pattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(pattern)) {
        frag.append(text.slice(last, m.index));
        const chip = document.createElement("span");
        chip.className = "agentnote-share";
        try {
          const r = await this.store.resolveShare(m[0]);
          chip.textContent = r.content;
          chip.title = `${m[0]} → ${r.title}（实时）`;
        } catch (e) {
          chip.textContent = `⚠ ${m[0]}: ${(e as Error).message}`;
          chip.classList.add("agentnote-share-dead");
        }
        frag.append(chip);
        last = (m.index ?? 0) + m[0].length;
      }
      frag.append(text.slice(last));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** FR-2: creation modal that walks the user through the boundary fields. */
class CreateNodeModal extends Modal {
  constructor(
    app: App,
    private plugin: AgentNotePlugin,
    private initialContent = ""
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "新建 agentNote 记忆" });

    const fields: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};
    const add = (
      key: string,
      label: string,
      kind: "input" | "textarea" | "select" = "input",
      placeholder = ""
    ) => {
      const wrap = contentEl.createDiv({ cls: "agentnote-field" });
      wrap.createEl("label", { text: label });
      let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (kind === "textarea") el = wrap.createEl("textarea");
      else if (kind === "select") {
        el = wrap.createEl("select");
        for (const t of ["snippet", "file", "folder"] as NodeType[]) {
          (el as HTMLSelectElement).createEl("option", { value: t, text: t });
        }
      } else el = wrap.createEl("input");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.placeholder = placeholder;
      }
      fields[key] = el;
    };

    add("title", "标题", "input", "这条记忆叫什么");
    add("type", "类型", "select");
    add("path", "磁盘路径（仅 file/folder）", "input", "D:/path/to/target（只索引，不复制）");
    add("content", "内容", "textarea");
    add("background", "背景（这条记忆从哪来）", "textarea");
    add("scenarios", "适用场景（什么时候用它）", "textarea");
    add("caveats", "注意与失效条件（什么时候不该用）", "textarea");
    add("tags", "标签（逗号分隔）", "input", "a, b, c");

    fields.content.value = this.initialContent;

    const btn = contentEl.createEl("button", { text: "创建", cls: "mod-cta" });
    btn.onclick = async () => {
      try {
        const node = await this.plugin.store.createNode({
          type: fields.type.value as NodeType,
          title: fields.title.value,
          content: fields.content.value,
          path: fields.path.value || undefined,
          boundary: {
            background: fields.background.value,
            scenarios: fields.scenarios.value,
            caveats: fields.caveats.value,
          },
          tags: fields.tags.value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          source: "user",
        });
        this.close();
        new Notice(`agentNote: 节点已创建: ${node.id}`);
        const rel = await this.plugin.store.nodeFilePath(node.id);
        const file = this.app.vault.getAbstractFileByPath(rel);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      } catch (e) {
        new Notice(`agentNote: ${(e as Error).message}`);
      }
    };
  }
}

/** Install the agentNote skill (SKILL.md) so local agents can use the memory layer. */
class InstallSkillModal extends Modal {
  constructor(app: App, private plugin: AgentNotePlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "为本地 agent 安装 agentNote skill" });
    contentEl.createEl("p", {
      text: "自动识别本机已安装的 agent，把 SKILL.md（读/写/规范三件事）写进它们的 skill 目录；安装后重启对应 agent 生效。",
    });

    const detected = detectAgents(os.homedir());
    const selected = new Map<string, string>(); // label -> dir
    for (const a of detected) selected.set(a.name, a.skillDir);

    if (detected.length === 0) {
      contentEl.createEl("p", {
        text: "没有识别到常见的本地 agent（Claude Code / Codex / WorkBuddy）。可以用下面的自定义目录手动安装。",
      });
    } else {
      contentEl.createEl("h3", { text: `识别到 ${detected.length} 个 agent` });
      for (const a of detected) {
        new Setting(contentEl)
          .setName(`${a.name}${a.alreadyInstalled ? "（已安装，将覆盖更新）" : ""}`)
          .setDesc(a.skillDir)
          .addToggle((t) =>
            t.setValue(true).onChange((v) => {
              if (v) selected.set(a.name, a.skillDir);
              else selected.delete(a.name);
            })
          );
      }
    }

    let customDir = "";
    new Setting(contentEl)
      .setName("自定义目录（可选）")
      .setDesc("其他 agent 的 skill 目录，填写后一并安装")
      .addText((t) => {
        t.setPlaceholder("例如 D:\\tools\\myagent\\skills\\agentnote")
          .onChange((v) => (customDir = v.trim()));
        t.inputEl.style.width = "100%";
      });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("安装").setCta().onClick(() => {
          const port = this.plugin.server?.port ?? this.plugin.settings.port;
          const prefs = this.plugin.settings.agentPreferences;
          const targets = [...selected.entries()];
          if (customDir) targets.push(["自定义目录", customDir]);
          if (targets.length === 0) {
            new Notice("agentNote: 没有选中任何安装目标");
            return;
          }
          const okLines: string[] = [];
          const failLines: string[] = [];
          for (const [label, dir] of targets) {
            try {
              installSkill(dir, { port, prefs });
              okLines.push(`${label}: ${dir}`);
            } catch (e) {
              failLines.push(`${label}: ${(e as Error).message}`);
            }
          }
          this.close();
          if (okLines.length > 0) {
            new Notice(
              `agentNote skill 已安装到 ${okLines.length} 个 agent:\n${okLines.join("\n")}\n（端口 ${port} 已写入；改端口后需重新安装）`,
              12000
            );
          }
          if (failLines.length > 0) {
            new Notice(`agentNote: ${failLines.length} 个目标安装失败:\n${failLines.join("\n")}`, 12000);
          }
        })
      )
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
  }
}

class AgentNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AgentNotePlugin) {
    super(app, plugin);
  }

  display(): void {
    const contentEl: HTMLElement = this.containerEl;
    contentEl.empty();
    contentEl.createEl("h2", { text: "agentNote" });

    new Setting(contentEl)
      .setName("Agent API 端口")
      .setDesc("供 agent 访问的本地 HTTP 端口（仅 localhost，下次启动服务时生效）。")
      .addText((t) =>
        t
          .setPlaceholder("27182")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0 && n < 65536) {
              this.plugin.settings.port = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(contentEl)
      .setName("加载插件时自动启动 API 服务")
      .setDesc("只有 Obsidian（及本服务）运行时，agent 才能读写记忆。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autostartServer).onChange(async (v) => {
          this.plugin.settings.autostartServer = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(contentEl)
      .setName("Agent 偏好")
      .setDesc("自由文本，会附加到导出的 agent 接入说明末尾（FR-9）。")
      .addTextArea((t) =>
        t
          .setPlaceholder("例如：优先用中文总结；不要把涉密内容写进节点。")
          .setValue(this.plugin.settings.agentPreferences)
          .onChange(async (v) => {
            this.plugin.settings.agentPreferences = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(contentEl)
      .setName("服务控制")
      .addButton((b) => b.setButtonText("启动").onClick(() => this.plugin.startServer()))
      .addButton((b) => b.setButtonText("停止").onClick(() => this.plugin.stopServer()));
  }
}
