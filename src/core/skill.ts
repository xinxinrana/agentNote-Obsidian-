import * as fs from "fs";
import * as path from "path";

export interface AgentTarget { id: string; name: string; detectRel: string; skillsRel: string; website: string }
export interface DetectedAgent extends AgentTarget { skillDir: string; available: boolean; installed: boolean }
export interface AgentPromptOptions { port: number; instructions?: string; agentId?: string; agentName?: string; template?: string }

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

const TEMPLATE_TOKENS = {
  baseUrl: "{{baseUrl}}",
  agentId: "{{agentId}}",
  agentName: "{{agentName}}",
  encodedAgentId: "{{encodedAgentId}}",
  encodedAgentName: "{{encodedAgentName}}",
} as const;

export const DEFAULT_SKILL_TEMPLATE = `---
name: agentnote
description: 用户的 Obsidian 本地笔记和文件中转系统。用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”时，使用它把内容写入笔记；用户给出 agentNote 分享地址时，直接读取地址。
---

# agentNote

agentNote 让用户 vault 中的内容通过本地 HTTP 流向 agent。服务地址：{{baseUrl}}。仅本机可访问；连接被拒绝表示 Obsidian 未启动。

## 自然语言写入

当用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”或语义等价的话时，创建一条笔记，不要求用户提供文件路径或 API 参数。

\`\`\`json
POST {{baseUrl}}/api/nodes
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

用户提供 \`{{baseUrl}}/api/shares/s-x-.../resolve\` 时，直接 GET 并使用返回内容。

- \`kind: text\`：正文和背景。
- \`kind: file\`：文件地址、背景和当前文件内容。
- \`kind: folder\`：文件夹地址、背景和第一层文件名称。

追加 \`?raw=1\` 只获取内容文本。不要要求用户复制原文件或重新粘贴正文。

## 固定身份与工作轨迹（必须携带）

此 skill 目录中的 \`agentnote.identity.json\` 是当前 agent 的默认身份配置。每次调用前先读取它，并始终使用其中的 \`id\` 与 \`name\`；不要根据模型、任务或会话自行改名。服务端会优先采用已登记的固定身份，以保证同一 agent 的工作轨迹连续一致。

每次调用 agentNote HTTP API 都携带以下请求头，让用户能在本地工作台看到哪一个 agent 在什么时间使用或修改了哪份资料：

\`\`\`
X-AgentNote-Agent-Id: {{encodedAgentId}}
X-AgentNote-Agent-Name: {{encodedAgentName}}
X-AgentNote-Session-Title: <encodeURIComponent(根据当前具体工作填写的简短标题)>
\`\`\`

请求头值必须使用 \`encodeURIComponent\` 编码；服务会自动解码展示。同一项工作在整个会话内复用同一个 \`X-AgentNote-Session-Title\`，例如“优化数据库分析 SOP”。开始新工作时换成新的具体标题。身份为本地申报信息，用于用户查看工作轨迹，不是鉴权机制。

## 读取与修改的规则

分享返回中的 \`filePath\` 是内容在本机的真实路径，\`hint\` 是使用规则：

- 读取始终优先通过链接，它返回当前内容和背景。
- 更新已分享内容时，PATCH \`/api/shares/<shareId>\`，请求体为 \`{ "content": "更新后的完整内容" }\`。

## 活动查询与总结

- GET \`{{baseUrl}}/api/insights/overview\`：查看本周概览、趋势和资料排名。
- GET \`{{baseUrl}}/api/insights/activity?from=<开始时间>&to=<结束时间>\`：查询指定时间段的操作，可追加 \`agent\`、\`action\`、\`nodeId\` 或 \`documentId\` 筛选。时间使用 UTC ISO 格式（如 \`2026-09-20T16:00:00.000Z\`），参数需 URL 编码，包含起止时间；本周按用户本地周一零点计算并转换为 UTC。
- GET \`{{baseUrl}}/api/insights/agents\`：查看各 agent 的累计分享读取、创建和修改次数。
- GET \`{{baseUrl}}/api/insights/documents\`：查看资料的累计分享读取次数、使用过的 agent 和最近使用时间。

响应中的 \`data\` 是查询结果，查询统计不会新增活动。用户要求提炼本周重点时，先查本周活动，再按需阅读相关正文生成分享内容；活动量仅作线索，不代表工作强度或成果。

也可按需读取 \`GET {{baseUrl}}/api/health\` 返回的 \`data.vault\` 下的 \`agentNote/data/events*.json\` 活动日志，用于回顾与总结；日志由插件维护，请勿修改。

## 可用接口

\`\`\`
GET  {{baseUrl}}/api/health
GET  {{baseUrl}}/api/nodes?q=
GET  {{baseUrl}}/api/nodes/<id>
POST {{baseUrl}}/api/nodes
PATCH {{baseUrl}}/api/nodes/<id>
POST {{baseUrl}}/api/shares
PATCH {{baseUrl}}/api/shares/<shareId>
GET  {{baseUrl}}/api/shares/<id>/resolve
\`\`\`
`;

export function renderSkillSource({ instructions = "", template = DEFAULT_SKILL_TEMPLATE }: Pick<AgentPromptOptions, "instructions" | "template">): string {
  return `${template.trimEnd()}${instructions.trim() ? `\n\n## 此 agent 的人工附加要求（更高优先级）\n\n${instructions.trim()}\n` : "\n"}`;
}

export function renderSkillMd({ port, instructions = "", agentId = "agentnote", agentName = "未命名 agent", template = DEFAULT_SKILL_TEMPLATE }: AgentPromptOptions): string {
  const base = `http://127.0.0.1:${port}`;
  const resolved = renderSkillSource({ template, instructions })
    .replaceAll(TEMPLATE_TOKENS.baseUrl, base)
    .replaceAll(TEMPLATE_TOKENS.agentId, agentId)
    .replaceAll(TEMPLATE_TOKENS.agentName, agentName)
    .replaceAll(TEMPLATE_TOKENS.encodedAgentId, encodeURIComponent(agentId))
    .replaceAll(TEMPLATE_TOKENS.encodedAgentName, encodeURIComponent(agentName));
  return resolved;
}

export function installSkill(dir: string, options: AgentPromptOptions): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), renderSkillMd(options), "utf8");
  fs.writeFileSync(path.join(dir, "agentnote.identity.json"), JSON.stringify({ version: 1, id: options.agentId ?? "agentnote", name: options.agentName ?? "未命名 agent" }, null, 2), "utf8");
}

/** A portable task for agents outside the built-in registry. */
export function renderManualInstallPrompt({ port, template }: Pick<AgentPromptOptions, "port" | "template">): string {
  const base = `http://127.0.0.1:${port}`;
  const skill = renderSkillMd({ port, template });
  return `请把 agentNote 安装为你自己可持久化使用的一项 skill、instruction 或工具说明。不要假设你必须使用某个固定目录；先识别你当前运行环境中用于保存长期技能/系统指令的正确机制，再自行创建或更新名为 agentnote 的条目。

安装前先验证服务：GET ${base}/api/health。若连接失败，不要伪造安装成功；请告诉用户需要打开 Obsidian 或启动 agentNote 本地服务。

以下是内置 agent 使用的完整默认提示词。按你的运行环境采用可在后续会话自动加载的格式保存它：

\`\`\`markdown
${skill}
\`\`\`

同时创建 \`agentnote.identity.json\`，保存你自己的固定 \`id\` 与 \`name\`。将提示词中的请求头示例替换为该身份信息，并在每次 API 调用时使用它。

完成后请自行验证：读取刚创建的 skill/instruction，确认内容完整；再 GET ${base}/api/health。最后向用户简短报告你把它安装在什么机制/位置，以及验证结果。`;
}

export function uninstallSkill(dir: string): void {
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) fs.rmSync(file);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
