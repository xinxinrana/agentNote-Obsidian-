# agentNote UI 设计思路稿

> 完全抛开现有面板，从"调度台"的隐喻重新出发。这份是思路稿，不是实现稿——用来对齐方向，再决定哪些落进代码。

## 1. 问题重述

agentNote 不是笔记应用，不是文件浏览器，不是仪表盘。**用户是文档调度师**：决定什么东西值得被 agent 读、什么东西该归档、什么东西要分享给哪个 agent。

现有面板的问题不是"丑"，而是**隐喻错了**：它把 agentNote 做成了" Obsidian 的一个侧边栏列表"，让人用"浏览笔记"的方式处理"调度任务"。搜索框、分组树、节点行——全是浏览型组件，缺少"待处理队列"、"路由"、"批量裁决"的调度语感。

## 2. 新隐喻：调度台（Dispatch Console）

把 agentNote 理解成一个小型仓库的调度台：

- **进货口（Inbox）**：agent 新写进来的记忆，等人审批
- **货架（Workspace）**：已入库、可被 agent 读取的记忆
- **出站口（Outbox）**：分享给其它 agent 的活引用链接
- **冷藏库（Archive）**：已退场但保留的记录
- **标签架（Groups）**：不是树，是可贴的彩色路由标签

用户的核心动作不是"打开看"，而是：

1. **扫一眼** —— 有什么新东西？状态是什么？
2. **裁决** —— approve / edit / archive / delete
3. **路由** —— 分到哪组、分享给谁
4. **追踪** —— 这条记忆被 agent 读过吗？分享链接还有效吗？

## 3. 布局：从侧边栏升级为全页视图

**建议改成 ItemView 全页标签页**（像 Obsidian 的 Graph、Backlinks 一样），不再做侧边栏。调度师需要空间。

```
┌─────────────────────────────────────────────────────────────────────┐
│  agentNote                                      [?] [设置]            │
├──────────┬───────────────────────────────────────┬──────────────────┤
│          │  Inbox (3)  Workspace (42)  Shares    │                  │
│ QUEUES   │  Archive    Groups                    │   DETAIL /       │
│          │                                       │   QUICK ACTIONS  │
│ ┌────┐   ├───────────────────────────────────────┤                  │
│ │Inbox│   │  🔴 未审批  payments retry policy      │                  │
│ │ 3  │   │      agent · 2 min ago · #payments    │  ┌────────────┐  │
│ └────┘   │      [批准] [编辑] [归档] [删除]       │  │ 边界字段    │  │
│          │                                       │  │ background │  │
│ Filters  │  🟢 已批准  user auth flow            │  │ scenarios  │  │
│ ─────────│      user · 1h ago · #auth #flow      │  │ caveats    │  │
│ type:    │                                       │  └────────────┘  │
│ ☑ snippet│  🟡 有警告  deploy rollback           │                  │
│ ☑ file   │      agent · 5h ago · 缺少 背景        │  [分享] [分组]  │
│ ☑ folder │      [补背景] [编辑] [归档]           │  [快照] [归档]  │
│          │                                       │                  │
│ Tags     │                                       │  最近读取:       │
│ #payments│                                       │  2 min ago by    │
│ #auth    │                                       │  Claude Code     │
│ ...      │                                       │                  │
└──────────┴───────────────────────────────────────┴──────────────────┘
```

### 3.1 左侧：Queues + Filters

_queues_ 是核心导航，不是分组树：

- **Inbox**：`source === "agent"` 且最近写入、尚未被用户看过/编辑/批准的节点（数字 badge）
- **Workspace**：活动节点，按时间倒序
- **Shares**：所有 `s-x-...` 引用，按创建时间倒序，吊销的单独可过滤
- **Archive**：归档节点
- **Groups**：不再是树，而是标签云 / 可点选的 chip 集合。点击 = 过滤 workspace

_filters_ 只在 Workspace/Archive 下出现：

- type 多选（snippet/file/folder）
- tag 多选
- 来源（agent/user）
- 是否有 warning
- 是否有未吊销 share

### 3.2 中间：Document Stream

不用表格，用**卡片流**（类似 Linear issues / Gmail compact）。每张卡片占一行，信息密度高。

卡片字段：

```
[status dot] [type icon] 标题                            [actions]
             source · 时间 · tags · groups · shares · warnings
```

- **status dot**：红=未审批/有警告，绿=正常，灰=归档
- **type icon**：📝 📄 📁
- **actions 常驻显示**：批准 / 编辑 / 归档 / 分享 / 分组（鼠标 hover 也可以，但最好常驻图标按钮）
- **多选模式**：checkbox 出现，顶部出现 bulk bar（ approving / 归档 / 分组 / 删除）

#### Inbox 的特殊性

Inbox 卡片默认展开一个 snippet：

```
┌────────────────────────────────────────────────────────────┐
│ 🔴 agent  ·  2 min ago                                     │
│ 标题：payments retry policy                                │
│                                                            │
│ "Retries at most 3 times..."                               │
│                                                            │
│ [批准并入库]  [要求补背景]  [编辑]  [归档]  [删除]          │
└────────────────────────────────────────────────────────────┘
```

"批准" = 把 `source` 从 `agent` 标记为 `approved` 或写一条 `reviewedAt`，让 Inbox 计数下降。这不是写新字段到节点 frontmatter——可以在 `data/reviews.json` 里存 `(nodeId, reviewedAt)`，保持节点文件纯净。

### 3.3 右侧：Detail / Quick Actions

点击卡片后右侧显示：

- **标题 + 类型 + 路径**
- **边界字段**（background / scenarios / caveats）高亮框
- **warnings**（如果有）
- **quick actions**：分享 / 分组 / 快照 / 归档 / 在 Obsidian 打开
- **shares 列表**（这条节点相关的活引用，可直接吊销/复制链接）
- **provenance preview**：默认 markdown 信封的样子
- **agent usage**：这条节点最近被哪些 agent 读过（可选，从 API access log 来，如果未来加的话）

## 4. 关键交互

### 4.1 审批工作流（Inbox → Workspace）

1. agent `POST /api/nodes` → 节点落盘 + 进 Inbox
2. 用户打开 agentNote → Inbox badge +1
3. 用户看卡片，点「批准并入库」→ `reviewedAt` 写入 `data/reviews.json`
4. 卡片从 Inbox 消失，Workspace 里出现

如果用户直接编辑了节点，也算"已审"，自动从 Inbox 移除。

### 4.2 批量裁决

多选后顶部出现 sticky bulk bar：

```
已选 5 项   [批准] [移至归档] [添加分组] [删除] [清空]
```

`删除` 要二次确认——真实删除文件。`归档` 是轻量操作。

### 4.3 分享 = 发运

从卡片点「分享」弹出 mini modal：

```
分享 "payments retry policy"
─────────────────────────────
类型: 节点
格式: [markdown 信封 ●] [raw] [json]
有效期: 永久 ○ / 7天 / 30天（可选）

[生成并复制链接]
```

生成后链接自动复制，并在 Shares 队列里出现一行：

```
s-x-abc123 · 📝 payments retry policy · 2026-08-13 · [复制] [吊销]
```

### 4.4 分组 = 路由标签

Groups 页面不是树，是"标签管理"：

```
┌─────────────────────────────────────────┐
│ 分组                                     │
│  [＋ 新建分组]                           │
│                                         │
│  工作 (12)     项目 A (4)               │
│  个人 (3)      项目 B (8)               │
│  待整理 (5)                               │
│                                         │
│ 点击分组 → 过滤 Workspace                │
└─────────────────────────────────────────┘
```

分组可以嵌套（保留现有 `parentId` 能力），但 UI 上**默认平铺**，只在你想建父子关系时才展开层级。大多数人的 brain 不擅长维护树。

## 5. 组件语言

全部使用 Obsidian 原生 CSS variables，不引入新组件库。

| 元素 | 样式 |
|---|---|
| 队列 tab | 类似 workspace-tab，带数字 badge |
| 卡片 | `--background-secondary` 底，1px border，hover 时 `--background-modifier-hover` |
| status dot | 8px 圆点：红 `--text-error`、绿 `--text-success`、黄 `--text-warning`、灰 `--text-muted` |
| action 按钮 | 图标按钮，tooltip，hover 才显色 |
| bulk bar | `--background-modifier-hover` 背景，sticky top |
| Inbox snippet | 卡片内嵌 quote 样式 |
| 边界字段框 | `--background-primary` 底 + 左边框 `--text-accent` |

### 5.1 一个 deliberately 的决定

**不用侧边栏。** agentNote 值得一个全页 tab。侧边栏只适合"看一眼"，调度工作至少需要三栏。

**如果坚持侧边栏怎么办？** 那就只显示 Inbox + Workspace 的紧凑列表，Detail 和批量操作必须跳转到全页 modal。体验会差一档，但可行。

## 6. 信息架构变化

| 现在 | 新设计 |
|---|---|
| 侧边栏面板 | 全页 ItemView tab |
| 搜索框 + 分组树 | Queues + Filters |
| 节点行 | 卡片流 |
| 单一列表混排 active/archived | 队列切分：Workspace / Archive |
| 分享行挤在底部 | 独立 Shares 队列 |
| 无审批概念 | Inbox + "批准" 动作 |
| 分组树 | 标签式分组管理 |
| 底部按钮 | 右侧 Quick Actions |

## 7. 数据层需要的小支持

为 UI 新隐喻服务，核心层可能要加/改：

1. **`data/reviews.json`**：`(nodeId, reviewedAt)` —— 谁在什么时候批准过。不污染节点 frontmatter。
2. **API `/api/nodes` 支持 `inbox=1` 过滤**：返回 `source === "agent"` 且未被 review 的节点。
3. **`PUT /api/nodes/:id/approve`**：标记已审批（或统一用 `POST /api/reviews`）。
4. **Share 支持可选过期时间**：如果未来要做 TTL。

这些都不影响现有 API，纯增量。

## 8. 优先级建议

如果要落地，建议按这个顺序：

1. **把面板改成全页 ItemView**（最大收益，解决" cramped "问题）
2. **Queues 切分**：Inbox / Workspace / Archive / Shares
3. **卡片流替换节点行**
4. **右侧 Detail + Quick Actions**
5. **Inbox 审批工作流**（需要 `data/reviews.json`）
6. **批量裁决条**
7. **分组标签化**
8. **分享独立队列 + TTL（可选）**

## 9. 不做什么

- 不做富文本编辑器：正文在 Obsidian 主区编辑
- 不做看板/日历/图谱：这些 Obsidian 原生已经很好，agentNote 只补充"调度"视图
- 不做复杂的权限系统：localhost + 无鉴权是设计选择
- 不做自动化 workflow：用户手动裁决，agent 服从

## 10. 一句话总结

**把 agentNote 从" Obsidian 侧边栏里的一个节点列表"改成"一个三栏调度台"：左边是队列，中间是待裁决的文档流，右边是详情与快捷动作。用户不是来浏览笔记的，是来批准、路由、发运记忆的。**
