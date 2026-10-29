# 项目协作约定

- 回复以“EE，我已经...”开头。
- 奥卡姆剃刀：如无必要，勿增实体。
- 无状态交付：产物直接可交付，不写版本补丁说明或“为何/如何修改”的过程描述。
- 提交 commit 信息默认用中文。

## Issue 与 Release

- 完成涉及 Issue 的任务后（或用户说“处理 GitHub”时）：推送代码，在 Issue 评论中记录问题、解决方式和验证结果，并关闭已完成的 Issue。
- 一次处理多个 Issue，最后用表格反馈结果。
- 默认不创建 Release，仅在用户明确要求时发布；发布时要说清本期做了什么、使用体验如何变化、怎样更新，并附真实截图或产品形象。

## 发布与社区检查

- 用户要求发布：发完 Release 后运行 `python3 scripts/check-community-release.py`。
- 用户说“帮我发布”：在项目根目录运行同一脚本，它会打开 agentNote 管理页和 “Check for new releases”。
- 脚本之后打开社区检查页 `https://community.obsidian.md/account/plugins/agentnote/check-release`，浏览器用已登录的 360 极速浏览器 Pro：`/usr/bin/open -b net.qihoo.360browser <url>`。用户说“先不要开始”时只记录、不打开。
