# Agent 技能接入兼容性

agentNote 的技能包含 `SKILL.md` 和按 agent 单独保存的 `agentnote.identity.json`。插件使用当前系统用户的主目录作为 `~`；同一相对目录在 macOS 和 Windows 上分别落在各自的用户目录下，不应写死 `/Users/...` 或 `C:\Users\...`。

| Agent | 官方确认的用户级位置 | 必需格式 | 接入判断 |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/agentnote/SKILL.md` | `SKILL.md` 带 `name`、`description` YAML frontmatter | 文件写入后，仍应在 Claude Code 中确认技能已加载并触发。 |
| Codex | `~/.agents/skills/agentnote/SKILL.md` | `SKILL.md` 带 `name`、`description` YAML frontmatter；`agents/openai.yaml` 仅用于可选的界面元信息、调用策略和依赖 | 同名技能不会合并；应检查是否有另一份 `agentnote`，并在 Codex 中确认实际加载来源。 |
| WorkBuddy | 当前未找到足以确认桌面端本地用户级目录的官方说明 | WorkBuddy 开放平台要求 `SKILL.md` 及其 YAML frontmatter；开放平台的元数据要求不应直接套用到桌面端本地目录 | 在桌面端确认安装方式和技能来源之前，不能把某个目录中存在文件当成接入成功。 |

来源：[Claude Code Skills 官方说明](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)、[OpenAI 官方 Build skills 文档](https://learn.chatgpt.com/docs/build-skills)、[WorkBuddy 开放平台 Skill 文档](https://open.workbuddy.cn/en/docs/skill)。

## 接入与更新规则

- 每个 agent 保留自己的身份 JSON。不要把一份公共技能及其身份文件直接共用给多个 agent。
- 安装前检查目标目录是否已有技能，以及是否存在同名的其他来源。发现冲突或用户修改过的文件时，先保留原件并明确展示状态，不静默覆盖、移动或删除。
- `SKILL.md` 写入成功只代表文件已安装。还需在对应 agent 的技能列表中确认可见，并通过一次实际调用核对请求头中的 agent 身份。
- 当前插件将 Codex 写到 `~/.codex/skills/agentnote`、WorkBuddy 写到 `~/.workbuddy/skills/agentnote`。前者与当前 OpenAI 官方用户级目录不一致；后者尚缺桌面端官方目录证据。这两项在验证前不应声明为自动接入成功。
