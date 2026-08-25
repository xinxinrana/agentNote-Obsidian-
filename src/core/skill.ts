import * as fs from "fs";
import * as path from "path";

export interface AgentTarget { id: string; name: string; detectRel: string; skillsRel: string }
export interface DetectedAgent extends AgentTarget { skillDir: string; installed: boolean }
export interface AgentPromptOptions { port: number; instructions?: string }

export const KNOWN_AGENTS: AgentTarget[] = [
  { id: "claude-code", name: "Claude Code", detectRel: ".claude", skillsRel: ".claude/skills" },
  { id: "codex", name: "Codex", detectRel: ".codex", skillsRel: ".codex/skills" },
  { id: "workbuddy", name: "WorkBuddy", detectRel: ".workbuddy", skillsRel: ".workbuddy/skills" },
];
const SKILL_NAME = "agentnote";

export function detectAgents(home: string): DetectedAgent[] {
  return KNOWN_AGENTS.filter((agent) => fs.existsSync(path.join(home, agent.detectRel))).map((agent) => {
    const skillDir = path.join(home, agent.skillsRel, SKILL_NAME);
    return { ...agent, skillDir, installed: fs.existsSync(path.join(skillDir, "SKILL.md")) };
  });
}

export function renderSkillMd({ port, instructions = "" }: AgentPromptOptions): string {
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

写入时根据用户表达整理标题、正文、背景和标签；背景或标签不明确时可以留空。写入前不需要为了找旧笔记而搜索。用户明确要求修改既有笔记时，先 GET 最新内容，再 PATCH 对应 id。

## 分享地址

用户提供 \`${base}/api/shares/s-x-.../resolve\` 时，直接 GET 并使用返回内容。它是活引用：每次读取都是当前内容。

- \`kind: text\`：正文和背景。
- \`kind: file\`：文件地址、背景和当前文件内容。
- \`kind: folder\`：文件夹地址、背景和第一层文件名称。

追加 \`?raw=1\` 只获取内容文本。不要要求用户复制原文件或重新粘贴正文。

## 可用接口

\`\`\`
GET  ${base}/api/health
GET  ${base}/api/nodes?q=
GET  ${base}/api/nodes/<id>
POST ${base}/api/nodes
PATCH ${base}/api/nodes/<id>
POST ${base}/api/shares
GET  ${base}/api/shares/<id>/resolve
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
3. 用户明确要求修改既有笔记时，先 GET ${base}/api/nodes/<id>，再 PATCH 同一地址；不要为了普通新建写入而先搜索旧笔记。
4. 用户给出 ${base}/api/shares/s-x-.../resolve 形式的地址时，直接 GET。它是活引用：每次都读当前内容，不要求用户重新复制文件。
5. 分享返回三种形态：kind=text 表示正文+背景；kind=file 表示文件地址+背景+当前内容；kind=folder 表示文件夹地址+背景+第一层文件名称。追加 ?raw=1 只获得内容文本。
6. 服务不可用只表示 Obsidian 或本地服务未运行，不表示用户文件丢失。

完成后请自行验证：读取刚创建的 skill/instruction，确认其中包含 ${base} 和“写到 Obsidian”的触发语义；再 GET ${base}/api/health。最后向用户简短报告你把它安装在什么机制/位置，以及验证结果。`;
}

export function uninstallSkill(dir: string): void {
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) fs.rmSync(file);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
