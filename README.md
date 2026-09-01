# agentNote × Obsidian

让本地笔记和文件直接流向 agent。

agentNote 是一个 Obsidian 插件，也是本地第二大脑的知识流动层。它把 vault 中由用户选定的笔记、文件、文件夹或一段选中文本变成只在本机可访问的 HTTP 地址。把地址发给 agent，它就能读取当前内容；不再需要反复复制文件路径、上传附件或粘贴正文。

同时，agentNote 让已接入的 agent 理解“写到 Obsidian”“记到笔记里”这类自然语言，并将内容直接写入你的本地笔记库。

它不会让 agent 无差别阅读整个 vault。你决定此刻让哪个 agent 关注哪份资料，agentNote 负责把这块内容和它的背景准确交接过去。

## 适合谁

- 经常把本地资料交给 Claude Code、Codex 或其他 agent 使用的人。
- 希望笔记留在自己的 Obsidian vault，而不是散落在聊天记录和临时附件里的人。
- 希望 agent 能读写笔记，但不想记 API、路径或重复说明上下文的人。

## 它能做什么

### 1. 把本地内容分享给 agent

在文件、文件夹或选中文本上使用“分享给 agent”，agentNote 会把地址复制到剪贴板。把这个地址发给 agent 即可。

这个地址是活引用：原文件更新后，agent 下次读取同一个地址时拿到的就是最新内容。

| 分享对象 | agent 会获得 |
|---|---|
| 一段文本 | 正文和背景 |
| 一个文件 | 文件地址、背景和当前内容 |
| 一个文件夹 | 文件夹地址、背景和第一层文件名称 |

### 2. 让 agent 直接写入 Obsidian

在接入台为 agent 安装提示词后，可以直接对它说：

> 把这次会议结论写到 Obsidian。

> 记到 agent 笔记里，标题叫“发布前检查”。

agent 会把标题、正文、背景和标签整理成笔记，写回当前 vault。你不需要提供文件路径或请求参数。

### 3. 管理接入的 agent

接入台会识别已安装的 Claude Code、Codex 和 WorkBuddy，并提供：

- 接入或更新 agentNote 提示词
- 为不同 agent 增加专属要求
- 清楚地移除 agentNote 接入，不影响该 agent 的其它配置
- 为任何未识别的 agent 复制一段通用安装任务

### 4. 维护常用内容

笔记可以归档，归档只是移入 vault 内的归档文件夹，不是删除。已归档内容仍可以重新分享或移回常用区。

## 安装

### 从 GitHub 下载

前往 [agentNote GitHub 仓库](https://github.com/xinxinrana/agentNote-Obsidian-)：

1. 若仓库已提供压缩包，在 [Releases 页面](https://github.com/xinxinrana/agentNote-Obsidian-/releases) 下载最新版本；否则从仓库源码构建。
2. 解压后，把 `main.js`、`manifest.json`、`styles.css` 放入：
   ```text
   <你的 vault>/.obsidian/plugins/agentnote/
   ```
3. 重启 Obsidian，或在“第三方插件”中重新加载 agentNote。
4. 打开侧边栏的 agentNote 接入台，确认本地服务正在运行。
5. 在“接入 agent”中选择你的 agent，点击“接入 agentNote”。接入后重启对应 agent。

### 更新

在 Obsidian 设置 → agentNote 中点击“检查更新”。插件会从 GitHub Releases 的最新构建产物中判断是否有新版本；有更新时点击“更新到 vX.Y.Z”，下载完成后插件自动重载，无需手动替换文件。

## 本地与隐私

- 服务默认地址为 `http://127.0.0.1:27182`，只监听本机。
- 不上传 vault 内容，不提供账号、云同步或公网分享。
- Obsidian 关闭时，本地服务会停止；你的原始文件仍留在 vault 中。

## 作者

Evan · [github.com/xinxinrana](https://github.com/xinxinrana)

更多操作说明见 [功能与使用](docs/功能与使用.md)。产品原则见 [核心产品设计](docs/product-design.md)。
