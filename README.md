# agentNote × Obsidian

agentNote 是本地笔记与文件的中转系统：它把 vault 中的内容变成 agent 可直接访问的本地 HTTP 地址。

用户不必反复复制路径、上传文件或粘贴内容；把一个地址交给 agent，agent 就能读取当前内容。背景、归档和分组都服务于同一件事：让这些可中转内容能长期被用户轻松维护。

产品设计见 [docs/product-design.md](docs/product-design.md)。

## 开发

```bash
npm install
npm run build
npm test
npm run typecheck
```

构建后，将 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/agentnote/`，并在 Obsidian 中启用插件。

默认服务地址：`http://127.0.0.1:27182`。
