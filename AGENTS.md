# 项目协作约定

- 每次回复用户信息之前，以“EE，我已经...”开头。
- 遵从奥卡姆剃刀原则：如无必要，勿增实体。
- 产出成果保持无状态交付：每次修改时都保持产物是直接可交付的，不包含版本补丁说明、解释为何或怎么修改等过程描述。

## GitHub 收尾

用户说“处理 GitHub”时，检查当前改动和相关 Issue，按需推送代码、在 Issue 评论中记录问题、解决方式和验证结果，并关闭已完成的 Issue。默认不创建 Release；仅在用户明确要求时发布。
如果一次任务处理了多个 issue ，最后对话中反馈结果时优先考虑表格呈现
发布 Release 时，说明要让用户直接看懂本期做了什么、使用体验如何变化、怎样更新，并附上与内容相符的真实截图或产品 SVG 形象。

## 社区版本检查

用户明确要求发布时，完成 GitHub Release 后，运行社区版本检查脚本。用户要求“帮我点社区检查”时也直接运行。

发版完成后，还要用已登录的浏览器打开该插件的社区版本检查页：`https://community.obsidian.md/account/plugins/<plugin-id>/check-release`，例如本插件为 `https://community.obsidian.md/account/plugins/agentnote/check-release`。浏览器用本机已登录的 360 极速浏览器 Pro：`/usr/bin/open -b net.qihoo.360browser <url>`。用户说“先不要开始”时只记录、不打开。

## 社区商店发布

脚本使用已登录的 360 极速浏览器 Pro，打开 agentNote 管理页及“Check for new releases”对应地址。用户主动提示帮我发布时触发

- 项目内路径：`scripts/check-community-release.py`
- 本机完整路径：`/Users/evan/Code/agentNote-Obsidian-/scripts/check-community-release.py`
- 在项目根目录执行：`python3 scripts/check-community-release.py`


