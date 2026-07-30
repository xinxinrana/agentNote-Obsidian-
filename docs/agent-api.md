# agentNote agent 接入文档（FR-3 / FR-9）

> 本文档是自包含的：一个只拿到本文档的 agent（无人工提示）应能完成 PRD §9 的全部验收流程。
> 插件内命令 **"agentNote: Export agent integration prompt"** 会生成同样内容的精简版并复制到剪贴板；
> 面板/命令 **"为本地 agent 安装 skill"** 会自动识别本机已安装的 agent（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、WorkBuddy `~/.workbuddy/skills/`，也支持自定义目录），把等价的 SKILL.md 写进它们的 skill 目录，安装后重启对应 agent 生效。

## 0. 它是什么 —— 三件事

agentNote 是用户的**显式记忆层**。对 agent 来说整个系统就三件事：

1. **写**：`POST /api/nodes` 把值得长期记住的事写进去
2. **读**：`GET /api/nodes` 搜索、读取以往记忆
3. **守规范**：每条记忆都带边界字段，回答三个问题——
   - `background` 背景：这条记忆从哪来、为什么存在
   - `scenarios` 适用场景：什么情况下应该用它
   - `caveats` 注意与失效条件：什么时候不该用它 / 何时过期

其余功能（分享活引用、分组、快照）都是这三件事的延伸，见 §4 的完整 API 表。

## 1. 接入点

- 地址：`http://127.0.0.1:<port>`（默认端口 **27182**，可在插件设置中修改）
- 仅监听 localhost，无鉴权，数据不出本机
- 健康检查：`GET /api/health`
- **可用性**：服务随 Obsidian 运行。连接被拒绝 = 记忆层离线（Obsidian 未启动），不是数据丢失；重试或请用户打开 Obsidian。

## 2. 质量红线（必须遵守）

1. **写入必带边界**：你创建的每条记忆都必须填写 `boundary.background / scenarios / caveats` 三个字段。
2. **标记来源**：你的所有写入都必须带 `"source": "agent"`。缺边界的 agent 写入会在用户界面和 API 响应中被标记为低质量（`warnings` 字段）。
3. **先读后写**：修改节点前先 `GET` 它，避免覆盖用户的最新编辑。
4. **分享引用是活的**：`s-x-...` 引用必须在使用时实时解析，不要缓存解析结果。解析返回 410 = 用户已吊销或内容已变化，视为"用户收回了这段内容"。
5. **file/folder 节点只索引**：`path` 指向用户磁盘上的真实文件。除非你被明确授权操作那个文件本身，否则不要修改它。

## 3. 数据模型速览

```jsonc
// Node
{
  "id": "n-1a2b3c4d5e6f",
  "type": "snippet",              // snippet | file | folder
  "title": "payments retry policy",
  "tags": ["payments"],
  "boundary": { "background": "...", "scenarios": "...", "caveats": "..." },
  "source": "agent",              // user | agent
  "path": "D:/work/config.yml",   // 仅 file/folder
  "content": "正文（snippet 的记忆本体；file/folder 的描述）",
  "created": "...", "updated": "...",
  "warnings": [                   // 质量提醒（FR-8）
    { "code": "missing-boundary", "message": "...", "missing": ["caveats"] }
  ]
}
```

> 没有版本字段：历史管理交给 git（vault 即 git 仓库）。`/versions`、`/rollback` 端点已移除，调用会返回 404。

所有响应信封：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "error": "..." }`。

## 4. API

| 操作 | 方法与路径 | 请求体 |
|---|---|---|
| 健康检查 | `GET /api/health` | — |
| 列出节点（过滤） | `GET /api/nodes?tag=&q=&type=snippet\|file\|folder` | — |
| 读单个节点 | `GET /api/nodes/<id>` | — |
| 创建节点 | `POST /api/nodes` | Node 字段（见上，`id/created/updated` 由服务端生成） |
| 修改节点 | `PUT /api/nodes/<id>` | 任意子集：`title/content/boundary/tags/path/source` |
| 设置节点分组 | `PUT /api/nodes/<id>/groups` | `{ "groupIds": ["g-...", ...] }`（多对多） |
| 分组列表 | `GET /api/groups` | — |
| 新建分组 | `POST /api/groups` | `{ "name": "...", "parentId": null }`（树状） |
| 删除分组 | `DELETE /api/groups/<id>` | —（级联删子组，不动节点） |
| 创建分享 | `POST /api/shares` | `{ "nodeId": "n-...", "selection": "可选：正文中的精确片段" }` 或 `{ "path": "vault相对路径", "selection": "可选（仅文件）" }` |
| 分享列表 | `GET /api/shares` | — |
| 吊销分享 | `POST /api/shares/<s-x-id>/revoke` | — |
| 解析分享（JSON） | `GET /api/shares/<s-x-id>/resolve` | — |
| 解析分享（纯文本） | `GET /api/shares/<s-x-id>/resolve?raw=1` | —（`text/plain`，直接是内容本体） |
| 创建快照 | `POST /api/nodes/<id>/snapshots` | `{ "note": "..." }`（仅 file/folder 节点） |
| 快照列表 | `GET /api/nodes/<id>/snapshots` | — |

### 解析分享的响应

分享目标是松耦合的：源文档有什么，解析就给什么，不强求。`title` / `content` / `scope` / `updated` 一定有；`boundary` / `warnings` / `nodeId` 只有目标是记忆节点时才有。

```jsonc
{
  "ok": true,
  "data": {
    "shareId": "s-x-...",
    "title": "...",          // 节点标题 / 文件名（去扩展名）/ 文件夹名
    "scope": "selection",    // full | selection | listing（folder 分享为 listing）
    "content": "...",        // 当前最新内容 —— 活引用；listing 时是逐行相对路径清单
    "updated": "...",        // ISO：节点 updated 或文件 mtime
    // 以下仅当分享目标是记忆节点时存在：
    "nodeId": "n-...",
    "nodeTitle": "...",
    "boundary": { ... },
    "warnings": [ ... ]
  }
}
```

可分享的对象有三种：`node`（记忆节点，带 boundary）、`file`（vault 里任意文件，解析时实时读盘）、`folder`（任意文件夹，解析为实时递归清单，500 条封顶）。文件/文件夹用 `path`（vault 相对路径，拒绝绝对路径与 `..`）创建分享。

分享链接形如 `http://127.0.0.1:<port>/api/shares/s-x-XXXXXXXXXXXX/resolve` —— 无需鉴权，直接 GET 即可读到**当前**内容。加 `?raw=1` 返回 `text/plain` 纯文本（适合只想要内容、不想解 JSON 的工具）。不要缓存解析结果，使用时重新 GET。

失败语义：`404` 引用不存在；`410` 已吊销（"share has been revoked"）、选段已不在当前正文中，或分享的文件/文件夹已被删除。这些都必须按"内容不可用"处理，且不要拿旧缓存顶替。

## 5. 端到端示例（curl）

```bash
B=http://127.0.0.1:27182

# 1. 写入一条带边界的记忆
curl -s -X POST $B/api/nodes -H 'content-type: application/json' -d '{
  "type":"snippet","title":"deploy freeze window","source":"agent",
  "content":"No production deploys between Friday 18:00 and Monday 09:00.",
  "boundary":{"background":"SRE policy after the 2026-05 outage",
              "scenarios":"Planning or executing any production deploy",
              "caveats":"Hotfixes for sev-1 incidents are exempt"},
  "tags":["deploy","policy"]}'
# → {"ok":true,"data":{"id":"n-aaa...",...}}

# 2. 读最新内容
curl -s $B/api/nodes/n-aaa...

# 3. 分享其中一段并解析
curl -s -X POST $B/api/shares -H 'content-type: application/json' \
  -d '{"nodeId":"n-aaa...","selection":"No production deploys"}'
curl -s $B/api/shares/s-x-bbb.../resolve          # JSON 信封
curl -s "$B/api/shares/s-x-bbb.../resolve?raw=1"  # 纯文本: No production deploys

# 3b. 分享 vault 里任意文件 / 文件夹（按路径）
curl -s -X POST $B/api/shares -H 'content-type: application/json' -d '{"path":"notes/deploy.md"}'
curl -s -X POST $B/api/shares -H 'content-type: application/json' -d '{"path":"notes"}'   # 文件夹 → 实时清单

# 4. 吊销后再解析 → 410
curl -s -X POST $B/api/shares/s-x-bbb.../revoke
curl -s $B/api/shares/s-x-bbb.../resolve   # {"ok":false,"error":"...revoked..."}
```
