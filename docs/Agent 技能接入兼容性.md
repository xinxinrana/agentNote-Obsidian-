# Agent 技能接入

agentNote 的接入控制面板始终显示 Claude Code、Codex 和 WorkBuddy，也支持其他 Agent。所有入口复制同一段安装任务；Agent 自行选择其实际加载技能的目录，下载同一份 `SKILL.md`，并在安装后回报真实路径。三个预设名称按忽略大小写的方式匹配；其他名称会追加到列表。

本机服务运行时，`GET http://127.0.0.1:27182/api/skill.md` 提供通用 Skill 文档。若在插件设置中更改了端口，使用新的端口。安装目录应包含：

```text
agentnote/
├── SKILL.md
└── agentnote.identity.json
```

身份文件至少包含当前 Agent 固定的 `id` 和 `name`。安装完成后，通过 `POST /api/agents/register` 上报 `{"name":"Agent 名称","skillPath":"SKILL.md 的绝对路径"}`。名称须与身份文件一致。插件核对文件存在、Skill 元信息和身份文件后，将真实路径登记在本机配置中。接入控制面板显示完整 Skill 预览，并提供独立的附加要求输入框；也可以解锁编辑全文。保存时保留备份，外部修改过的文件不会被静默覆盖。

如 Agent 支持 Skill 图标，可从 `GET http://127.0.0.1:27182/api/skill-icon.svg` 下载小记图标，按该 Agent 的规范配置；不支持时直接跳过。端口以本机设置为准。

接入路径只保存在当前设备的 `~/.agentnote` 本机配置中，不随笔记库同步。看板仍按活动日志展示曾经协作的 Agent；一台设备上没有对应的 Skill 文件，也不影响历史记录显示。删除接入时，插件会备份并移走该 Agent 的 `SKILL.md`，保留协作历史。

Agent 仍需在自己的新会话中确认 Skill 已加载，并完成一次带身份请求头的真实调用。文件登记成功只表示本机找到了可管理的 Skill 文件，不代表 Agent 一定会调用它。

官方格式与目录资料：[Claude Code Skills](https://code.claude.com/docs/en/skills)、[OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills)、[WorkBuddy 开放平台 Skill](https://open.workbuddy.cn/docs/skill)。
