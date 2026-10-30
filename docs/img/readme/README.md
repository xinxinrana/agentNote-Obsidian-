# README 视觉素材

| 素材 | 内容与来源 |
| --- | --- |
| `knowledge-in-motion.png` | 概念主视觉，由内置 imagegen 生成。旧笔记汇聚成新成果，再回到个人知识库；不是软件截图。中英文共用。 |
| `knowledge-loop-zh.svg` / `knowledge-loop-en.svg` | 可编辑的流程图：自己的笔记 → Agent 工作 → 新的知识。文字保持为 SVG 文本。 |
| `workspace-demo-*.png` | 当前 `AgentNoteView` 组件与公开示例笔记的展示排版。外层工作空间是演示宿主，不是对用户笔记库的截图。 |
| `profile-demo-*.png` | 当前 `InsightsModal` 组件的演示画面。活动统计由临时演示库的真实核心逻辑计算，不是用户数据。 |
| `workspace-*.png` / `profile-*.png` | 早期截图，保留供原有引用使用；当前 README 使用上面的演示素材。 |

演示画面可执行 `node scripts/build-readme-assets.mjs` 重新生成。需要已有 Chrome；macOS 使用标准安装路径，其他路径通过 `CHROME_PATH` 指定。脚本仅使用临时目录中的演示库和隔离的无头浏览器，不访问运行中的 Obsidian、个人笔记库或已安装的 Skill。界面样式来自当前 `styles.css`，宿主提供基础字体与主题变量。示例日期为渲染当天。

标识复用 `assets/brand/agentnote-lockup.svg`；深色背景使用 `agentnote-lockup-dark.svg`。版本、下载量和许可证徽章由 Shields.io 提供动态 SVG，下载量来源为 Obsidian 官方 `community-plugin-stats.json` 的 `agentnote.downloads`，不把数值写死。

## 主视觉生成提示词

工具：内置 `imagegen`；背景不透明。文字与标识在 README 中单独排版。

```text
Use case: ads-marketing / stylized-concept. Asset: a single premium landscape 16:9 hero artwork for agentNote, an Obsidian plugin that lets people put their accumulated personal knowledge to work with AI agents, then bring the results back to their own notes. This is conceptual brand artwork, not a screenshot. Primary visual story: accumulated notes become a beautiful useful new artifact and return to a personal archive, a closed cycle of knowledge. Art direction: visually exhilarating, exceptionally polished editorial 3D still life, restrained and confident, the kind of strong luminous centerpiece that stops someone scrolling through a top developer tool README. Near-black plum background, porcelain ivory paper, saturated refined purple illumination (#8652CF), subtle lilac highlights, a small warm champagne accent. Wide, carefully art-directed composition. A striking tall sculptural folded document at the center-right, rendered like exquisite translucent porcelain and layered paper, with a crisp dog-eared corner, luminous abstract typeset blocks and one beautiful diagram-like inset (no readable letters). At left a small ordered collection of older paper notes with subtle annotations and structured marks, arranged in a gently ascending ribbon; their faint luminous filaments converge into the central accomplished document, then a clean purple ribbon of light sweeps beneath and returns toward a layered archival notebook in the foreground. The central artifact must look like the satisfying outcome of substantial work, not a generic blank floating card. The loop is elegant, physically coherent and visually legible, not a flowchart. Rich tactile paper edges, refined glass-like folds, exquisite soft shadows, physically plausible studio lighting, generous controlled negative space, extremely clear focal hierarchy, premium contrast, subtle fine grain only. Make the subject occupy much of the image so it remains striking at GitHub README width. Keep all important objects inside the central 85% safe area. No humans, no desktop or laptop, no robot, no invented logos, no mascots, no interface chrome, no literal arrows, no decorative scatter, no watermarks, no legible text, no headings. This is one cohesive finished editorial artwork, not a collage of options.
```
