# agentNote agent 接入文档（FR-3 / FR-9）

> 本文档是自包含的：一个只拿到本文档的 agent（无人工提示）应能完成 PRD §9 的全部验收流程。
> 插件内命令 **"agentNote: Export agent integration prompt"** 会生成同样内容的精简版并复制到剪贴板；
> 面板/命令 **"为本地 agent 安装 skill"** 会自动识别本机已安装的 agent（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、WorkBuddy `~/.workbuddy/skills/`，也支持自定义目录），把等价的 SKILL.md 写进它们的 skill 目录，安装后重启对应 agent 生效。

## 0. 它是什么 —— 三件事

agentNote 是用户的**显式记忆层**。对 agent 来说整个系统就三件事：

1. **写**：`POST /api/nodes` 把值得长期记住的事写进去
2. **读**：`GET /api/nodes` 搜索、读取以往记忆
3. **守规范**：每条记忆都带「背景」字段，回答一个问题——
   - `background` 背景：这条记忆从哪来、为什么存在

其余功能（分享活引用、分组、快照）都是这三件事的延伸，见 §4 的完整 API 表。

## 1. 接入点

- 地址：`http://127.0.0.1:<port>`（默认端口 **27182**，可在插件设置中修改）
- 仅监听 localhost，无鉴权，数据不出本机
- 健康检查：`GET /api/health`
- **可用性**：服务随 Obsidian 运行。连接被拒绝 = 记忆层离线（Obsidian 未启动），不是数据丢失；重试或请用户打开 Obsidian。

## 2. 质量红线（必须遵守）

1. **写入必带背景**：你创建的每条记忆都必须填写 `background` 字段。
2. **标记来源**：你的所有写入都必须带 `"source": "agent"`。缺背景的 agent 写入会在用户界面和 API 响应中被标记为低质量（`warnings` 字段）。
3. **先读后写**：修改节点前先 `GET` 它，避免覆盖用户的最新编辑。
4. **分享引用是活的**：`s-x-...` 引用必须在使用时实时解析，不要缓存解析结果。解析返回 410 = 用户已吊销或内容已变化，视为"用户收回了这段内容"。
5. **file/folder 节点只索引**：`path` 指向用户磁盘上的真实文件。除非你被明确授权操作那个文件本身，否则不要修改它。

## 3. 数据模型速览

```jsonc
// Node
{
  "id": "n-1a2b3c4d5e6f",
  "type": "snippet",              // snippet | file | folder
  "title": "payments retry policy", // 来自笔记文件名（改 title 会自动重命名文件）
  "tags": ["payments"],
  "background": "...",            // 背景：这条记忆从哪来、为什么存在
  "source": "agent",              // user | agent
  "path": "D:/work/config.yml",   // 仅 file/folder
  "content": "正文（snippet 的记忆本体；file/folder 的描述）",
  "created": "...", "updated": "...", // 来自文件 stat 时间
  "warnings": [                   // 质量提醒（FR-8）
    { "code": "missing-background", "message": "..." }
  ]
}
```

> 节点笔记的 frontmatter 是最小集：`agentnote / id / type / source / 背景 / tags / path`。
> 标题即文件名，created/updated 取文件 stat 时间，历史交给 git（vault 即 git 仓库）。
> `/versions`、`/rollback` 端点已移除，调用会返回 404。

所有响应信封：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

## 4. API

| 操作 | 方法与路径 | 请求体 |
|---|---|---|
| 健康检查 | `GET /api/health` | — |
| 列出节点（过滤） | `GET /api/nodes?tag=&q=&type=snippet\|file\|folder` | — |
| 读单个节点 | `GET /api/nodes/<id>` | — |
| 创建节点 | `POST /api/nodes` | Node 字段（见上，`id/created/updated` 由服务端生成） |
| 修改节点 | `PUT /api/nodes/<id>` | 任意子集：`title/content/background/tags/path/source` |
| 设置节点分组 | `PUT /api/nodes/<id>/groups` | `{ "groupIds": ["g-...", ...] }`（多对多） |
| 分组列表 | `GET /api/groups` | — |
| 新建分组 | `POST /api/groups` | `{ "name": "...", "parentId": null }`（树状） |
| 删除分组 | `DELETE /api/groups/<id>` | —（级联删子组，不动节点） |
| 创建分享 | `POST /api/shares` | `{ "nodeId": "n-...", "selection": "可选：正文中的精确片段" }` 或 `{ "path": "vault相对路径", "selection": "可选（仅文件）" }` |
| 分享列表 | `GET /api/shares` | — |
| 吊销分享 | `POST /api/shares/<s-x-id>/revoke` | — |
| 解析分享（markdown 信封，默认） | `GET /api/shares/<s-x-id>/resolve` | —（`text/markdown`，顶部带 provenance 归因块） |
| 解析分享（JSON） | `GET /api/shares/<s-x-id>/resolve?md=0` | — |
| 解析分享（纯文本） | `GET /api/shares/<s-x-id>/resolve?raw=1` | —（`text/plain`，直接是内容本体） |
| 创建快照 | `POST /api/nodes/<id>/snapshots` | `{ "note": "..." }`（仅 file/folder 节点） |
| 快照列表 | `GET /api/nodes/<id>/snapshots` | — |

### 解析分享的响应

分享目标是松耦合的：源文档有什么，解析就给什么，不强求。**`provenance` 永远在**——这是"它从哪来、为什么存在"的归因链；agent 拿到一段分享内容时立刻知道它属于什么主题、是否已归档、有没有警告。

`title` / `content` / `scope` / `updated` 一定有；`background` / `warnings` / `nodeId` 只有目标是记忆节点时才有。

**默认（`?md=1` 或无参）返回 `text/markdown` 信封**——上面是归因块（provenance），下面是围栏代码块包住的内容体。直接粘进 agent 上下文就完整可用。

```markdown
<!-- agentNote share: s-x-... -->
# 记忆节点：payments-service retry policy

## 归因（provenance）

- **shareId**: `s-x-...`
- **kind**: node
- **nodeId**: `n-...`
- **nodeTitle**: payments-service retry policy
- **source**: user
- **背景**: Decided in the 2026-06 incident review...
- **updated**: 2026-08-12T...
- **warnings**: （缺背景时列出）

## 内容

\`\`\`
The payments service retries at most 5 times...
\`\`\`
```

要纯文本：`?raw=1`（返回 `text/plain`，跳过归因和信封）。要 JSON：`?md=0`。

`?md=0` 时的 JSON 信封：

```jsonc
{
  "ok": true,
  "data": {
    "shareId": "s-x-...",
    "title": "...",          // 节点标题 / 文件名（去扩展名）/ 文件夹名
    "scope": "selection",    // full | selection | listing（folder 分享为 listing）
    "content": "...",        // 当前最新内容 —— 活引用；listing 时是逐行相对路径清单
    "updated": "...",        // ISO：节点 updated 或文件 mtime
    "provenance": {          // 归因链：永远在
      "kind": "node",        // node | file | folder | selection
      "nodeId": "n-...",
      "nodeTitle": "...",
      "source": "user",
      "background": "...",
      "warnings": [ ... ],
      "archived": false,
      "updated": "2026-08-12T..."
    },
    // 以下仅当分享目标是记忆节点时存在（兼容旧调用方）：
    "nodeId": "n-...",
    "nodeTitle": "...",
    "background": "...",
    "warnings": [ ... ]
  }
}
```

可分享的对象有三种：`node`（记忆节点，带背景）、`file`（vault 里任意文件，解析时实时读盘）、`folder`（任意文件夹，解析为实时递归清单，500 条封顶）。文件/文件夹用 `path`（vault 相对路径，拒绝绝对路径与 `..`）创建分享。

分享链接形如 `http://127.0.0.1:<port>/api/shares/s-x-XXXXXXXXXXXX/resolve` —— 无需鉴权，直接 GET 即可读到**当前**内容，**默认返回带归因块的 markdown 信封**。`?raw=1` 拿纯文本；`?md=0` 拿 JSON 信封。不要缓存解析结果，使用时重新 GET。

失败语义：`404` 引用不存在；`410` 已吊销、选段已不在当前正文中，或分享的文件/文件夹已被删除。这些都必须按"内容不可用"处理，且不要拿旧缓存顶替。

## 5. 端到端示例（curl）

```bash
B=http://127.0.0.1:27182

# 1. 写入一条带背景的记忆
curl -s -X POST $B/api/nodes -H 'content-type: application/json' -d '{
  "type":"snippet","title":"deploy freeze window","source":"agent",
  "content":"No production deploys between Friday 18:00 and Monday 09:00.",
  "background":"SRE policy after the 2026-05 outage; applies to deploy planning",
  "tags":["deploy","policy"]}'
# → {"ok":true,"data":{"id":"n-aaa...",...}}

# 2. 读最新内容
curl -s $B/api/nodes/n-aaa...

# 3. 分享其中一段并解析
curl -s -X POST $B/api/shares -H 'content-type: application/json' \
  -d '{"nodeId":"n-aaa...","selection":"No production deploys"}'
curl -s $B/api/shares/s-x-bbb.../resolve          # markdown 信封（默认，含归因块）
curl -s "$B/api/shares/s-x-bbb.../resolve?raw=1"  # 纯文本: No production deploys
curl -s "$B/api/shares/s-x-bbb.../resolve?md=0"   # JSON 信封

# 3b. 分享 vault 里任意文件 / 文件夹（按路径）
curl -s -X POST $B/api/shares -H 'content-type: application/json' -d '{"path":"notes/deploy.md"}'
curl -s -X POST $B/api/shares -H 'content-type: application/json' -d '{"path":"notes"}'   # 文件夹 → 实时清单

# 4. 吊销后再解析 → 410
curl -s -X POST $B/api/shares/s-x-bbb.../revoke
curl -s $B/api/shares/s-x-bbb.../resolve?md=0   # {"ok":false,"error":"...已吊销..."}
```
