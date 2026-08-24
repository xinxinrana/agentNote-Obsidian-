# agentNote 产品手册

> 这本手册给**装上插件的用户**看。如果你是 agent，要从 `GET /api/health` 接入，看 [agent-api.md](agent-api.md)。如果你想知道为什么这样设计，看 [architecture.md](architecture.md)。

## 它是什么

agentNote 是 Obsidian 里的一个**显式记忆层**——给本地跑的各种 agent（Claude Code、Codex、WorkBuddy、自家脚本）一块共享的、可读可写的笔记空间。**调度师是你**（用户），agentNote 是调度台，不是笔记系统。

一切围绕三件事：

1. **agent 写**——`POST /api/nodes` 把记忆落盘
2. **agent 读**——`GET /api/nodes` 搜索、读取
3. **agent 懂规范**——每条记忆必须带「背景」字段（这条记忆从哪来、为什么存在）；「为本地 agent 安装 skill」一键把规范教给本机的 agent

数据是 vault 里的纯 markdown + JSON，frontmatter 即规范本体。卸载插件后完整可读、可 git、不会被锁。

## 安装

```bash
npm install
npm run build      # 产出 main.js + test/core-bundle.cjs
```

把 `main.js`、`manifest.json`、`styles.css` 复制到：

```
<vault>/.obsidian/plugins/agentnote/
```

在 Obsidian 设置 → 第三方插件 → 已安装插件里启用 agentNote。

## 第一次使用

1. 打开 vault 后，agentNote 在右侧栏挂一个 brain 图标的视图
2. 工具栏 `＋ 新建` 写第一条记忆；或者直接用 `POST /api/nodes` 让 agent 写
3. 面板底部点「为本地 agent 安装 skill」——自动识别本机的 Claude Code / Codex / WorkBuddy（支持自定义目录），把 SKILL.md 装进它们的 skill 目录，之后 agent 自动会用本记忆层
4. 面板底部状态条显示 `🟢 agent API: http://127.0.0.1:27182` 时即服务运行中（仅 localhost，无鉴权，连接被拒绝 = Obsidian 没开）

端口、归档目录、skill 安装目录都在设置页可改。

## 核心概念

### 节点（node）

一条记忆就是一个节点。三种类型：

| 类型 | 用途 | 怎么工作 |
|---|---|---|
| `snippet` | 文字内容（决定、偏好、SOP） | 落到 `agentNote/nodes/<标题>.md`，正文即内容 |
| `file` | 索引磁盘上任意文件 | 不复制，存路径；读时实时读盘 |
| `folder` | 索引磁盘上任意文件夹 | 不复制，存路径；读时实时列清单 |

**标题即文件名**（不是 id）。创建/修改时间从文件 stat 取，重命名标题自动重命名 .md，正文是内容。frontmatter 是最小集：`agentnote / id / type / source / 背景 / tags / path`。

### 背景（boundary）

**每条记忆必带**。它把这条记忆变成"可被负责任地引用"的东西，而不是一段被丢进上下文里的裸文字。

三个字段：

- **background**：这条记忆从哪来、为什么存在
- **scenarios**：什么情况下 agent 应该用它
- **caveats**：什么时候不该用它 / 何时失效

规则：

1. agent 写入的每条记忆都必须带这三个字段，并标 `"source": "agent"`
2. **先读后写**：改一条记忆前先 GET 它，别覆盖用户最新编辑
3. 用户说"记住……"、"以后都……"时，agent 应主动写一条带完整边界的记忆

frontmatter 里只存 `背景: ` 这一个汉字字段（带冒号空格）。`scenarios` / `caveats` 进正文。**frontmatter 即规范本体**——它是 markdown 的、人类可读的，不是某个私有的 YAML 黑盒。

### 分组（group）

虚拟标签树，不影响节点文件本身。多对多：节点可同时在多个组，组可嵌套。一个节点在「2026 项目」组下，不等于它在「工作」组下——你来组织。

面板里建组、拖组、点 `▸/▾` 折叠。归档、分享、编辑都跟组无关——组只是工作台视图。

### 归档（archive）

**人工语义，不是数据删除**。把工作区根目录里的文件手动拖进 `agentNote/nodes/归档/`，面板把它折叠进 `归档 (N)` 块，仍可被搜索、分享、编辑、再次移出。

为什么这样：agent 不知道归档、也不该知道——它继续 `GET` 一切。归档是给**人**看的"已退场"标签。

### 分享（share）

`POST /api/shares` 把任何东西变成 `s-x-...` 活引用 HTTP 链接：

- 选段（任意选中的文字，自动定位到所在文件）
- 节点（`{ nodeId }`）
- 任意 vault 文件（`{ path }`，实时读盘）
- 任意文件夹（`{ path }`，实时列清单）

收件方 agent `GET /api/shares/<id>/resolve` 直接拿内容，**实时解析不缓存**。默认返回 markdown 信封（顶部有 provenance 归因块，标了它从哪来、是否已归档、有没有警告），直接粘进 agent 上下文就完整可用。`?raw=1` 拿纯文本，`?md=0` 拿 JSON 兼容旧客户端。吊销或目标删除后返回 410。

> 链接以 `?md=1` 为默认。默认给 agent 最省事的格式，markdown 信封自带 provenance，agent 拿过去就有完整上下文。

## 面板

侧边栏（brain 图标）打开后是 agentNote 的「调度台」：

```
[搜索框   ] [↻] [＋ 新建]            ← 工具栏（一次创建，永不销毁）

[批量条（仅当选中节点时出现）]
[工作区 (N)]                          ← 节点列表（按更新时间倒序）
[分组]                                ← 真嵌套树，可折叠
[分享引用 (N)]                        ← 所有活引用 + 吊销按钮
[🟢 agent API: http://127.0.0.1:PORT] ← 点切换服务启停
[📄 复制 agent 接入说明]
[🧩 为本地 agent 安装 skill]
```

每行节点：

- `📝/📄/📁` 类型图标 + 标题（点开即在 Obsidian 主区打开 .md）
- 元信息：`2026-08-12 · source · #tag1 #tag2 · in: 组A, 组B · 2 个活引用`
- 4 个动作：🔗 创建活引用（自动复制链接） / 🏷 指派分组 / 📥 移至归档或移出 / 📸 快照（file/folder 才有）

工具栏 `↻` 手动刷新；store 自己有事件总线（HTTP API / 面板按钮 / 外部修改）都自动重渲，↻ 只是兜底。

## 日常使用

**用户**日常怎么用

- 打开面板浏览所有记忆
- `＋ 新建` 加一条
- 在节点标题上点开 → Obsidian 主区编辑（标准 markdown）
- 框选几行文字 → 右键 → `agentNote: 分享选段` → 自动复制 `s-x-...` 链接发给别人或别的 agent
- 归档不想再看的：把 `.md` 拖进 `agentNote/nodes/归档/`
- 不想删除但要断流：把分享点 `🚫` 吊销

**agent** 日常怎么用

- 开始任何工作前：`GET /api/nodes?q=<关键词>` 看相关历史
- 写决定时：`POST /api/nodes` 带 background / scenarios / caveats
- 改既有记忆时：`GET /api/nodes/<id>` 先看最新版本，再 `PUT` 局部更新
- 跨 agent 通信：让对方 `GET /api/shares/<id>/resolve` 拿你刚分享的内容

## 配置与维护

**设置项**（Obsidian 设置 → agentNote）

- HTTP 端口（默认 27182）
- 归档目录名（默认 `归档`，改成 `archive` / `done` 也行——仅人类视觉，agent 看不到）
- skill 安装目录（默认 `~/.claude/skills/agentnote` 等已知路径，可加自定义）

**数据位置**

```
<vault>/agentNote/
  nodes/                ← 所有 .md 记忆（snippet 类型的内容在文件里）
  data/
    groups.json         ← 分组（虚拟标签树，删除不影响节点）
    shares.json         ← 分享（吊销记录）
    snapshots/          ← 快照（file/folder 的只读副本）
  versions.legacy-backup/  ← 旧版 versions/ 目录的迁移备份（plugin 不会删）
```

**重置 agentNote**

1. 禁用插件
2. 删 `agentNote/` 目录
3. 启用插件

**升级**

1. 备份 `agentNote/` 目录（其实 git 就够了）
2. 替换 `main.js` / `manifest.json` / `styles.css`
3. 重新启用插件——所有数据是普通 markdown + JSON，零迁移

## 常见问题

**Obsidian 没开，agent 能用吗？**

不能。HTTP 服务随 Obsidian 进程生命周期走。`connection refused` = Obsidian 没开，**不是数据丢失**。重试或请用户打开 Obsidian。如果需要 7×24，可把 `src/core/` 包装成独立 daemon（架构见 [architecture.md](architecture.md)）。

**agent 写入了低质量记忆怎么办？**

没带 `background` 的记忆，agent 自己读时会被 API 标 `warnings: ["missing 边界字段"]`，面板里加 ⚠。不强制阻断，但写的人/agent 该看见就看见。

**归档和删除的区别？**

归档 = 文件挪进 `归档/` 子目录，仍可读可搜可分享。
删除 = 文件从磁盘上消失，不可恢复（除非 git）。

归档默认折叠在面板底部。要彻底删除，在 Obsidian 主区右键 → 删除文件即可。

**为什么我手动建了子目录（比如 `agentNote/nodes/2026Q3/`）面板没把它当分组？**

因为分组是 `groups.json` 里的虚拟标签树，跟磁盘子目录无关。磁盘子目录会被 `store.bulkArchive` 跳过（不在合法归档目录里），但仍可被搜索和分享——它是用户的私人整理，跟 agent 协议无关。

**`s-x-...` 链接发给别的 agent，对方也要装 agentNote 吗？**

不用。`s-x-.../resolve` 是纯 HTTP 公开端点（仅 localhost），任何能访问这个端口的 agent `curl` 一下就有内容。收件方不需要任何插件。

**Obsidian 重启后端口变了/被占？**

设置页改端口，点面板底部 `🔴 agent API 未运行` 重新启动。如果端口被占，杀掉占用进程或换端口。

**怎么给特定 agent（如只给 Claude Code，不给 Codex）安装 skill？**

设置页「skill 安装目录」自定义添加。默认自动识别 `~/.claude/skills/agentnote`、`~/.codex/skills/agentnote`、`~/.workbuddy/skills/agentnote`，改掉或删掉你不想给的。

## 哲学

- **用户是调度师**，agentNote 是调度台（不是笔记系统）
- **不增加新概念**：节点即笔记、分组即标签树、归档即文件夹、分享即 URL
- **不引入第三方 UI 库**，只用 Obsidian 原生能力
- **不锁数据**：vault 即数据库，git 即历史，卸载即还原
- **agent 协议最小化**：只 `GET` / `POST` / `PUT` / `DELETE` 四个动作，三件事就讲完

详见 [product-philosophy.md](product-philosophy.md)。
