# agentNote 产品形象：小记

小记是一张会陪伴资料流转的折角笔记。以下 SVG 是可编辑的主文件；静态形象在 `png/` 中提供同名透明背景位图，适合不支持 SVG 的场合。

[视觉识别规范（VI）](VI.md)包含标志、色彩、字体、留白和应用规则。

[小记动态角色规范](MOTION.md)定义角色动作、触发条件与验收标准。动态角色直接使用 [xiaoji-pet.svg](xiaoji-pet.svg)，可运行 `npm run preview:pet` 并打开 `test/pet-preview.html` 检查。

[三张使用场景插画](scenes/README.md)展示分享资料、agent 读取和成果写回笔记库，可用于产品介绍与演示。

| 用途 | 预览 | SVG | PNG |
| --- | --- | --- | --- |
| 常态角色 | <img src="xiaoji-idle.svg" alt="小记常态" width="96"> | [xiaoji-idle.svg](xiaoji-idle.svg) | [PNG](png/xiaoji-idle.png) |
| 欢迎与分享 | <img src="xiaoji-wave.svg" alt="小记挥手" width="96"> | [xiaoji-wave.svg](xiaoji-wave.svg) | [PNG](png/xiaoji-wave.png) |
| 思考与提示 | <img src="xiaoji-thinking.svg" alt="小记思考" width="96"> | [xiaoji-thinking.svg](xiaoji-thinking.svg) | [PNG](png/xiaoji-thinking.png) |
| 小尺寸标记 | <img src="xiaoji-mark.svg" alt="笔记标记" width="64"> | [xiaoji-mark.svg](xiaoji-mark.svg) | [PNG](png/xiaoji-mark.png) |
| 接入台动态角色 | <img src="xiaoji-pet.svg" alt="小记动态角色站姿" width="52"> | [xiaoji-pet.svg](xiaoji-pet.svg) | — |
| 品牌组合 | <img src="agentnote-lockup.svg" alt="agentNote 品牌组合" width="200"> | [agentnote-lockup.svg](agentnote-lockup.svg) | [PNG](png/agentnote-lockup.png) |

常态、挥手和思考采用 512 × 512 画布；标记与动态角色为 128 × 128，横向品牌组合为 1000 × 260。它们都带透明背景。小尺寸界面使用标记；静态角色全身图建议展示在 72 px 以上，动态角色按 52 px 绘制。

主色为紫色 `#8652CF`，面部深紫 `#392552`，纸张浅色 `#F8F3FF`，腮红 `#F7A5C8`。使用时保留折角、表情和完整轮廓，不拉伸比例；放在浅色或能保持轮廓清晰的背景上。
