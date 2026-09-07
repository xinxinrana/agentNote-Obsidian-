import * as fs from "fs";
import * as path from "path";

export interface AgentTarget { id: string; name: string; detectRel: string; skillsRel: string; website: string }
export interface DetectedAgent extends AgentTarget { skillDir: string; available: boolean; installed: boolean }
export interface AgentPromptOptions { port: number; instructions?: string; agentName?: string }

export const KNOWN_AGENTS: AgentTarget[] = [
  { id: "claude-code", name: "Claude Code", detectRel: ".claude", skillsRel: ".claude/skills", website: "https://claude.com/product/claude-code" },
  { id: "codex", name: "Codex", detectRel: ".codex", skillsRel: ".codex/skills", website: "https://openai.com/codex/" },
  { id: "workbuddy", name: "WorkBuddy", detectRel: ".workbuddy", skillsRel: ".workbuddy/skills", website: "https://www.workbuddy.cn/" },
];
const SKILL_NAME = "agentnote";

export function detectAgents(home: string): DetectedAgent[] {
  return KNOWN_AGENTS.map((agent) => {
    const skillDir = path.join(home, agent.skillsRel, SKILL_NAME);
    return { ...agent, skillDir, available: fs.existsSync(path.join(home, agent.detectRel)), installed: fs.existsSync(path.join(skillDir, "SKILL.md")) };
  });
}

export function renderSkillMd({ port, instructions = "", agentName = "未命名 agent" }: AgentPromptOptions): string {
  const base = `http://127.0.0.1:${port}`;
  return `---
name: agentnote
description: 用户的 Obsidian 本地笔记和文件中转系统。用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”时，使用它把内容写入笔记；用户给出 agentNote 分享地址时，直接读取地址。
---

# agentNote

agentNote 让用户 vault 中的内容通过本地 HTTP 流向 agent。服务地址：${base}。仅本机可访问；连接被拒绝表示 Obsidian 未启动。

## 自然语言写入

当用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”或语义等价的话时，创建一条笔记，不要求用户提供文件路径或 API 参数。

\`\`\`json
POST ${base}/api/nodes
{
  "title": "简短主题",
  "content": "整理后的正文",
  "background": "这是什么、从哪来、为什么要保存",
  "tags": ["可选标签"],
  "source": "agent"
}

\`\`\`

写入时根据用户表达整理标题、正文、背景和标签；背景或标签不明确时可以留空。写入前不需要为了找旧笔记而搜索。

写入成功的响应包含 \`status\` 和 \`link\`：\`link\` 是这条笔记的永久地址，写入后立即把它发给用户，并在后续对话中用它指代这条笔记。用户之后说"修改刚才那篇"时，直接用这条 link，不要重新搜索。

## 分享地址

用户提供 \`${base}/api/shares/s-x-.../resolve\` 时，直接 GET 并使用返回内容。它是活引用：每次读取都是当前内容。

- \`kind: text\`：正文和背景。
- \`kind: file\`：文件地址、背景和当前文件内容。
- \`kind: folder\`：文件夹地址、背景和第一层文件名称。

追加 \`?raw=1\` 只获取内容文本。不要要求用户复制原文件或重新粘贴正文。

## 工作轨迹（必须携带）

每次调用 agentNote HTTP API 都携带以下请求头，让用户能在本地工作台看到哪一个 agent 在什么时间使用或修改了哪份资料：

\`\`\`
X-AgentNote-Agent-Name: ${encodeURIComponent(agentName)}
X-AgentNote-Session-Title: <encodeURIComponent(根据当前具体工作填写的简短标题)>
\`\`\`

请求头值必须使用 \`encodeURIComponent\` 编码；服务会自动解码展示。同一项工作在整个会话内复用同一个 \`X-AgentNote-Session-Title\`，例如“优化数据库分析 SOP”。开始新工作时换成新的具体标题。身份为本地申报信息，用于用户查看工作轨迹，不是鉴权机制。

## 读取与修改的规则

分享返回中的 \`filePath\` 是内容在本机的真实路径，\`hint\` 是使用规则：

- 读取始终优先通过链接，它返回当前内容和背景。
- 需要修改时，如果你有本地文件能力，直接对 \`filePath\` 做局部编辑，不要通过接口全量重写。笔记文件是带 frontmatter 的 Markdown：正文可以直接改，frontmatter 中的 \`id\`、\`type\`、\`source\` 等字段保持不变。
- 没有本地文件能力时，GET 链接拿到当前内容，再 PATCH \`/api/nodes/<id>\`。

## 可用接口

\`\`\`
GET  ${base}/api/health
GET  ${base}/api/nodes?q=
GET  ${base}/api/nodes/<id>
POST ${base}/api/nodes
PATCH ${base}/api/nodes/<id>
POST ${base}/api/shares
GET  ${base}/api/shares/<id>/resolve
GET  ${base}/api/insights/overview
GET  ${base}/api/insights/activity?agent=&nodeId=&action=
GET  ${base}/api/insights/agents
GET  ${base}/api/insights/documents
\`\`\`
${instructions.trim() ? `\n## 此 agent 的附加要求\n\n${instructions.trim()}\n` : ""}`;
}

export function installSkill(dir: string, options: AgentPromptOptions): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), renderSkillMd(options), "utf8");
}

/** A portable task for agents outside the built-in registry. */
export function renderManualInstallPrompt({ port }: Pick<AgentPromptOptions, "port">): string {
  const base = `http://127.0.0.1:${port}`;
  return `请把 agentNote 安装为你自己可持久化使用的一项 skill、instruction 或工具说明。不要假设你必须使用某个固定目录；先识别你当前运行环境中用于保存长期技能/系统指令的正确机制，再自行创建或更新名为 agentnote 的条目。

安装前先验证服务：GET ${base}/api/health。若连接失败，不要伪造安装成功；请告诉用户需要打开 Obsidian 或启动 agentNote 本地服务。

写入以下能力说明，并按你的运行环境采用可在后续会话自动加载的格式：

1. agentNote 是用户的 Obsidian 本地笔记和文件中转系统，服务地址是 ${base}，仅本机可访问。
2. 当用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”或语义等价的话时，调用 POST ${base}/api/nodes 创建笔记。根据用户表达整理 title、content、background、tags 和 source: "agent"；background 要说明这是什么、从哪来、为什么保存。
3. 写入成功的响应包含 status 和 link：link 是这条笔记的永久地址。写入后立即把 link 发给用户，并在后续对话中用它指代这条笔记；用户说“修改刚才那篇”时直接用这条 link，不要重新搜索。
4. 用户给出 ${base}/api/shares/s-x-.../resolve 形式的地址时，直接 GET。它是活引用：每次都读当前内容，不要求用户重新复制文件。
5. 分享返回三种形态：kind=text 表示正文+背景；kind=file 表示文件地址+背景+当前内容；kind=folder 表示文件夹地址+背景+第一层文件名称。追加 ?raw=1 只获得内容文本。
6. 分享返回中的 filePath 是内容在本机的真实路径。读取始终优先通过链接；需要修改时，如果你有本地文件能力，直接对 filePath 做局部编辑（笔记文件是带 frontmatter 的 Markdown，正文可改，id/type/source 等字段保持不变），不要全量重写；没有本地文件能力时，GET 链接后 PATCH /api/nodes/<id>。
7. 每次调用 agentNote HTTP API 都发送 X-AgentNote-Agent-Name（你的 agent 名称）和 X-AgentNote-Session-Title（根据当前具体工作填写的会话标题）请求头，让用户能查看本地工作轨迹。
8. 服务不可用只表示 Obsidian 或本地服务未运行，不表示用户文件丢失。

完成后请自行验证：读取刚创建的 skill/instruction，确认其中包含 ${base} 和“写到 Obsidian”的触发语义；再 GET ${base}/api/health。最后向用户简短报告你把它安装在什么机制/位置，以及验证结果。`;
}

export function uninstallSkill(dir: string): void {
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) fs.rmSync(file);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
