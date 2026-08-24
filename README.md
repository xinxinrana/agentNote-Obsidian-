# agentNote × Obsidian

用户与 AI agent 之间的**显式记忆层**，以 Obsidian 插件形态落地。大道至简，就三件事：

1. **agent 写**：本地 HTTP API 写入记忆（`POST /api/nodes`）
2. **agent 读**：搜索、读取记忆（`GET /api/nodes`）
3. **agent 懂规范**：每条记忆必带一个「**背景**」字段（这条记忆从哪来、为什么存在）；「安装 skill」一键把规范教给本地 agent（Claude Code 等）

其余都是这三件事的自然延伸：

- 数据是 vault 里的纯 markdown + JSON，frontmatter 即规范本体，卸载插件后完整可读、可 git
- 历史交给 git：无内置版本管理（PRD FR-4 已被 2026-07-29 用户决策取代，见 docs/architecture.md）
- 可分享：任意片段、笔记、文件、文件夹都能生成 `s-x-...` 活引用 HTTP 链接，其他 agent 直接 GET 即得内容，可吊销

> **产品哲学**：用户是文档调度师，agentNote 是调度台（不是笔记系统）。详见 [docs/product-philosophy.md](docs/product-philosophy.md)。
>
> **用户手册**：[docs/user-manual.md](docs/user-manual.md) — 安装、日常使用、常见问题。

## 安装与构建

```bash
npm install
npm run build        # 产出 main.js（插件）+ test/core-bundle.cjs（测试用核心包）
npm test             # 端到端黑盒测试：无 Obsidian、起真实 HTTP 服务跑 §9 验收全流程
npm run typecheck
```

部署到 Obsidian：把 `main.js`、`manifest.json`、`styles.css` 复制到
`<vault>/.obsidian/plugins/agentnote/`，在设置里启用。

## 它怎么工作（30 秒版）

agent 侧只需要记住三件事——**写**（`POST /api/nodes`）、**读**（`GET /api/nodes` 搜索/单读）、**守规范**（`background` 背景字段 + `source: agent` + 先读后写）。「为本地 agent 安装 skill」会自动识别本机的 agent（Claude Code / Codex / WorkBuddy，支持自定义目录），把这份规范写成 SKILL.md 装进它们的 skill 目录，之后 agent 自动会用。

数据侧：

- **节点即笔记**：`agentNote/nodes/<标题>.md`（标题命名，frontmatter 里的 `id` 是稳定锚点；重名自动加数字后缀）。frontmatter 是最小集：`agentnote / id / type / source / 背景 / tags / path`——标题即文件名，创建/修改时间取文件 stat，正文是内容。`snippet` = 内容随笔记走；`file`/`folder` = frontmatter 里的 `path` 索引磁盘任意路径，**只索引，绝不复制或修改真实文件**。
- **历史**：无内置版本系统——vault 交给 git 管理。旧版 `agentNote/versions/` 目录在插件加载时自动迁移为 `versions.legacy-backup/`（不删除）。
- **分享**：`agentNote/data/shares.json`。什么都能分享：选段、记忆节点、vault 里任意文件（实时读盘）、任意文件夹（实时递归清单）——文件/文件夹按 vault 相对路径创建。解析永远读目标当前内容（活引用）；结果与来源松耦合：文档有什么就给什么，附文件标题作轻量上下文。`GET /api/shares/<s-x-id>/resolve` 默认返回 **markdown 信封**（顶部是 provenance 归因块，标了它从哪来、是否已归档、有没有警告）——直接粘进 agent 上下文就完整可用；`?raw=1` 得纯文本；`?md=0` 得 JSON。吊销或目标删除后返回 410。
- **agent 通道**：插件内嵌 `http://127.0.0.1:27182`（可配置），仅 localhost。完整文档见 [docs/agent-api.md](docs/agent-api.md)。
- **更多能力**：多对多分组树（`groups.json`，纯虚拟）、file/folder 只读快照——面板里可用，不是核心叙事。

## 架构与关键结论

选型与理由见 [docs/architecture.md](docs/architecture.md)。两个必须知道的结论：

1. **路线 A：插件自包含**。单一事实源 = vault 里的纯文本文件；无外部服务。
2. **Obsidian 未运行时 agent 不能读写**（连接拒绝 = 离线，不是数据丢失）。核心层 `src/core/` 零 Obsidian 依赖，未来可包装成常驻守护进程拉平可用性。

## 目录结构

```
src/core/    纯 Node 核心：types / nodeFile(frontmatter) / store / server —— 不 import obsidian
src/main.ts  Obsidian 插件层：命令、模态框、设置页、阅读视图渲染
test/e2e.mjs 黑盒测试：32 个用例覆盖 PRD §9 验收流程 + FR-1/3/5/6/7/8 + 旧布局迁移
docs/        PRD、架构抉择记录、agent 接入文档
```

## PRD 对照

| 需求 | 状态 | 位置 |
|---|---|---|
| FR-1 三种 Node 一等表达 | ✅ | `src/core/store.ts` createNode（file/folder 强制 path） |
| FR-2 背景可见可编、写入引导 | ✅ | 创建模态框 + 阅读视图背景面板（`main.ts`） |
| FR-3 agent 读写通道 | ✅ | `src/core/server.ts` + `docs/agent-api.md` |
| FR-4 版本与回滚 | ⛔ 已移除 | 2026-07-29 用户决策：历史交给 git，见 `docs/architecture.md` |
| FR-5 分享（活引用/嵌入/吊销） | ✅ | `store.ts` shares + post processor 实时解析 |
| FR-6 多对多分组树 | ✅ | `store.ts` groups |
| FR-7 只读快照 | ✅ | `store.ts` createSnapshot |
| FR-8 来源标记与质量提醒 | ✅ | `types.ts` qualityWarnings + 界面横幅 + API warnings |
| FR-9 agent prompt 导出 | ✅ | 命令 "Export agent integration prompt" + 「安装 skill」（`src/core/skill.ts`） |
| FR-10 复用原生能力 | ✅ | 节点即普通 markdown，搜索/图谱/标签/双链原生可用 |
| §6 可用性书面结论 | ✅ | `docs/architecture.md` |
| §9 验收七步 | ✅ | `test/e2e.mjs` 全部通过 |
