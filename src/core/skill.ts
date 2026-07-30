/**
 * Skill installer — writes a SKILL.md that teaches local agents (Claude Code,
 * Codex, WorkBuddy and any other agent that reads skill files) how to use
 * this vault's agentNote memory layer over the local HTTP API.
 *
 * Pure Node, no Obsidian imports: covered by the e2e tests.
 */

import * as fs from "fs";
import * as path from "path";

export interface SkillInstallResult {
  dir: string;
  file: string;
}

/** A local agent whose skill directory we know how to find. */
export interface AgentTarget {
  id: string;
  name: string;
  /** Directory (relative to home) whose existence marks this agent as installed. */
  detectRel: string;
  /** User-level skills directory (relative to home). */
  skillsRel: string;
}

/** Common local agents, all using the <skillsRel>/agentnote/SKILL.md convention. */
export const KNOWN_AGENTS: AgentTarget[] = [
  { id: "claude-code", name: "Claude Code", detectRel: ".claude", skillsRel: ".claude/skills" },
  { id: "codex", name: "Codex (OpenAI)", detectRel: ".codex", skillsRel: ".codex/skills" },
  { id: "workbuddy", name: "WorkBuddy", detectRel: ".workbuddy", skillsRel: ".workbuddy/skills" },
];

export interface DetectedAgent extends AgentTarget {
  /** Absolute dir the skill would be installed into. */
  skillDir: string;
  /** True if an agentnote SKILL.md is already present there. */
  alreadyInstalled: boolean;
}

const SKILL_FOLDER = "agentnote";

/** Detect which known agents are installed under the given home directory. */
export function detectAgents(homeDir: string): DetectedAgent[] {
  const found: DetectedAgent[] = [];
  for (const agent of KNOWN_AGENTS) {
    if (!fs.existsSync(path.join(homeDir, agent.detectRel))) continue;
    const skillDir = path.join(homeDir, agent.skillsRel, SKILL_FOLDER);
    found.push({
      ...agent,
      skillDir,
      alreadyInstalled: fs.existsSync(path.join(skillDir, "SKILL.md")),
    });
  }
  return found;
}

/** Claude Code user-level skills directory layout: <home>/.claude/skills/<name>/SKILL.md */
export function defaultSkillDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "skills", SKILL_FOLDER);
}

/**
 * Render the skill definition. The port is baked in so the skill works
 * without any discovery step; if the user later changes the plugin port they
 * should re-install the skill.
 *
 * 叙事只讲三件事：读、写、守规范。其余能力（分享/分组/快照）一笔带过。
 */
export function renderSkillMd(opts: { port: number; prefs?: string }): string {
  const base = `http://127.0.0.1:${opts.port}`;
  const prefs = (opts.prefs ?? "").trim();
  return `---
name: agentnote
description: 读写用户的 agentNote 显式记忆层（Obsidian vault 里的长期记忆）。当用户让你"记住"某件事、查询以往记忆、使用 s-x- 分享引用，或任务需要跨会话的用户偏好/项目约定时使用。
---

# agentNote — 用户的显式记忆层

就三件事：**读、写、守规范**。本地 HTTP API：${base}（仅 localhost、无鉴权）。
服务随 Obsidian 运行：**连接被拒绝 = Obsidian 没开**，不是数据丢失——重试或请用户打开 Obsidian。

## 一、规范（最重要）

每条记忆都必须能回答三个问题，缺了就是低质量记忆：

- **background**：这条记忆从哪来、为什么存在
- **scenarios**：什么情况下应该用它
- **caveats**：什么时候不该用它 / 何时失效

规则：

1. 你写入的每条记忆都必须带这三个 boundary 字段，并标 \`"source": "agent"\`。
2. 先读后写：改一条记忆前先 GET 它，别覆盖用户的最新编辑。
3. 用户说"记住……"、"以后都……"时，主动写一条带完整边界的记忆。

## 二、读

\`\`\`
GET ${base}/api/nodes?tag=&q=&type=snippet|file|folder   # 搜索/列出（q 搜标题正文标签）
GET ${base}/api/nodes/<id>                               # 读单条（含 boundary 和 warnings）
GET ${base}/api/health                                   # 健康检查
\`\`\`

需要用户过往的决定、偏好、流程 SOP 时，**先搜记忆再回答**。

## 三、写

\`\`\`
POST ${base}/api/nodes
{"type":"snippet","title":"...","content":"...",
 "boundary":{"background":"...","scenarios":"...","caveats":"..."},
 "tags":[],"source":"agent"}

PUT  ${base}/api/nodes/<id>    # 改任意子集（改 title 会自动重命名笔记文件，id 不变）
\`\`\`

响应信封：\`{"ok":true,"data":...}\` 或 \`{"ok":false,"error":"..."}\`。

## 顺带一提

- **分享引用**：用户发来的 ${base}/api/shares/s-x-.../resolve 链接，直接 GET 即得当前内容（加 \`?raw=1\` 拿纯文本）。**实时解析、别缓存**；410 = 用户已吊销，视为收回。
- 节点文件就是 vault 里 \`agentNote/nodes/\` 下的普通 markdown，frontmatter 即规范本体，直接读文件也能学会格式。
${prefs ? `\n## 用户偏好\n\n${prefs}\n` : ""}`;
}

/** Write SKILL.md into the given directory (created if missing). Overwrites any previous install. */
export function installSkill(dir: string, opts: { port: number; prefs?: string }): SkillInstallResult {
  if (!dir.trim()) throw new Error("skill directory must not be empty");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, renderSkillMd(opts), "utf8");
  return { dir, file };
}
