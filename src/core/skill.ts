import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export interface AgentTarget { id: string; name: string; detectRel: string; skillsRel: string; website: string }
export interface DetectedAgent extends AgentTarget { skillDir: string; available: boolean; installed: boolean }
export interface AgentPromptOptions { port: number; instructions?: string; agentId?: string; agentName?: string; template?: string }
export type SkillStatus = "current" | "update" | "custom" | "unknown";

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
description: 用户的 Obsidian 本地笔记和文件中转系统。用户说“写到 Obsidian”、“写到 agent 笔记”、“记到笔记里”时，使用它把内容写入笔记；用户给出 27182 端口的地址时，使用它读取，不要用网页抓取工具直接访问。
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

新建笔记的标题采用「类型 ｜ 文档标题」（全角竖线），如「会议纪要 ｜ 项目复盘」；用户明确指定标题时以用户要求为准。正文可以使用 Obsidian Markdown，例如双链、任务列表和 callout。

写入时根据用户表达整理标题、正文、背景和标签；背景或标签不明确时可以留空。写入前不需要为了找旧笔记而搜索。

写入成功的响应包含 \`status\` 和 \`link\`：\`link\` 是这条笔记的永久地址，写入后立即把它发给用户，并在后续对话中用它指代这条笔记。用户之后说"修改刚才那篇"时，直接用这条 link，不要重新搜索。

## 分享地址

用户提供 \`{{baseUrl}}/api/shares/s-x-.../resolve\` 时，直接 GET 并使用返回内容。
用户一次提供多个分享地址时，逐一读取，再结合任务处理。

- \`kind: text\`：正文和背景。
- \`kind: file\`：文件地址、背景和当前文件内容。
- \`kind: folder\`：文件夹地址、背景和第一层文件名称。

追加 \`?raw=1\` 只获取内容文本。不要要求用户复制原文件或重新粘贴正文。

按需读取分享笔记中的双链目标：GET \`{{baseUrl}}/api/shares/<id>/links\` 获取 \`targetPath\`，再 POST \`{{baseUrl}}/api/shares\`（\`{"path":"<targetPath>"}\`）并 GET 返回的 \`/resolve\`。

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
GET  {{baseUrl}}/api/shares/<id>/links
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

/** The same downloadable skill is used by every installation entry. */
export function renderSharedSkillMd(port: number): string {
  return DEFAULT_SKILL_TEMPLATE
    .replaceAll(TEMPLATE_TOKENS.baseUrl, `http://127.0.0.1:${port}`)
    .replaceAll(TEMPLATE_TOKENS.encodedAgentId, "<读取 agentnote.identity.json 的 id 并进行 URL 编码>")
    .replaceAll(TEMPLATE_TOKENS.encodedAgentName, "<读取 agentnote.identity.json 的 name 并进行 URL 编码>")
    .replaceAll(TEMPLATE_TOKENS.agentId, "<agentnote.identity.json 的 id>")
    .replaceAll(TEMPLATE_TOKENS.agentName, "<agentnote.identity.json 的 name>");
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function skillStatus(dir: string, options: AgentPromptOptions): SkillStatus {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return "unknown";
  try {
    const installed = digest(fs.readFileSync(file, "utf8"));
    const identity = JSON.parse(fs.readFileSync(path.join(dir, "agentnote.identity.json"), "utf8")) as Record<string, unknown>;
    if (identity.id !== (options.agentId ?? "agentnote")) return "unknown";
    if (options.template !== undefined && options.template !== DEFAULT_SKILL_TEMPLATE) return "custom";
    if (typeof identity.skillHash !== "string" || typeof identity.defaultTemplateHash !== "string") return installed === digest(renderSkillMd(options)) ? "current" : "unknown";
    if (installed !== identity.skillHash) return "custom";
    return identity.defaultTemplateHash === digest(DEFAULT_SKILL_TEMPLATE) ? "current" : "update";
  } catch { return "unknown"; }
}

export function skillInstallConflict(dir: string, agentId: string): boolean {
  const skillFile = path.join(dir, "SKILL.md");
  const identityFile = path.join(dir, "agentnote.identity.json");
  if (!fs.existsSync(skillFile) && !fs.existsSync(identityFile)) return false;
  try {
    const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as Record<string, unknown>;
    return identity.id !== agentId || identity.skillHash !== digest(fs.readFileSync(skillFile, "utf8"));
  } catch { return true; }
}

export function installSkill(dir: string, options: AgentPromptOptions, overwriteExisting = false): void {
  const conflict = skillInstallConflict(dir, options.agentId ?? "agentnote");
  if (conflict && !overwriteExisting) throw new Error("现有技能或身份文件不是该 agentNote 接入的未修改版本，已停止覆盖");
  fs.mkdirSync(dir, { recursive: true });
  if (conflict) {
    const suffix = `.agentnote-backup-${randomUUID()}`;
    for (const name of ["SKILL.md", "agentnote.identity.json"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}${suffix}`, fs.constants.COPYFILE_EXCL);
    }
  }
  const skill = renderSkillMd(options);
  fs.writeFileSync(path.join(dir, "SKILL.md"), skill, "utf8");
  fs.writeFileSync(path.join(dir, "agentnote.identity.json"), JSON.stringify({ version: 1, id: options.agentId ?? "agentnote", name: options.agentName ?? "未命名 agent", skillHash: digest(skill), defaultTemplateHash: digest(DEFAULT_SKILL_TEMPLATE) }, null, 2), "utf8");
}

/** A portable task for agents outside the built-in registry. */
export function renderManualInstallPrompt({ port }: Pick<AgentPromptOptions, "port">): string {
  const base = `http://127.0.0.1:${port}`;
  return `请安装 agentNote Skill。它是用户的 Obsidian 本地笔记和文件中转工具，用于读取分享、查找和写入笔记。

1. 从 ${base}/api/skill.md 下载 Skill 文件，保存为你实际使用的技能目录中的 agentnote/SKILL.md，并完成当前 Agent 所需的技能配置。
2. 在同一目录创建 agentnote.identity.json，填写你固定的 id 和 name，例如 {"id":"your-agent-id","name":"Your Agent Name"}。之后按 Skill 说明使用这份身份。
3. 安装后 POST ${base}/api/agents/register，上报 {"name":"你的 Agent 名称","skillPath":"SKILL.md 的绝对路径"}。上报名称与身份文件中的 name 保持一致，供 Obsidian 管理这份 Skill。

如当前 Agent 支持为 Skill 设置图标，推荐从 ${base}/api/skill-icon.svg 下载并使用；不支持则跳过。

最后简单确认新会话能够使用该 Skill。如果本地链接无法访问，提醒用户打开 Obsidian 的 agentNote 服务。`;
}

export function uninstallSkill(dir: string): void {
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) fs.rmSync(file);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
