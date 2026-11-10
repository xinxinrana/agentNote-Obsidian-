import MarkdownIt from "markdown-it";
import * as path from "path";
import { language, t } from "../i18n";
import type { ShareResult } from "./store";

// Raw HTML and unsafe link schemes stay disabled. Shared notes are content, not page scripts.
const markdown = new MarkdownIt({ html: false, linkify: false });
const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Compact reads keep the content and its scope; dates and absolute paths are opt-in. */
export function shareView(data: ShareResult, detail: boolean) {
  if (detail) return data;
  const { updated: _updated, ...compact } = data;
  if (compact.kind === "files") return { ...compact, files: compact.files.map(({ title, address }) => ({ title, address })) };
  const { filePath: _filePath, ...result } = compact;
  return result;
}

/** Obsidian's native URI only applies to a single file inside the current vault. */
function obsidianLink(data: ShareResult, root: string): string | undefined {
  if (data.kind !== "text" && data.kind !== "file") return undefined;
  const relative = path.relative(root, data.filePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return `obsidian://open?vault=${encodeURIComponent(path.basename(root))}&file=${encodeURIComponent(relative.split(path.sep).join("/"))}`;
}

export function renderSharePage(data: ShareResult, root: string, detail = false, renderedContent?: string): string {
  const route = `/api/shares/${encodeURIComponent(data.shareId)}/resolve`;
  const open = obsidianLink(data, root);
  const kind = data.selection ? t("选段") : data.kind === "folder" ? t("文件夹") : data.kind === "files" ? t("多个文件") : t("笔记");
  const background = data.background ? `<aside class="background"><h2>${escape(t("背景"))}</h2><div>${markdown.render(data.background)}</div></aside>` : "";
  const scope = data.selection ? `<aside class="scope">${escape(t("这是分享的选段，不是全文。"))}</aside>`
    : data.kind === "folder" ? `<aside class="scope">${escape(t("这里只列出文件夹的第一层内容。"))}</aside>`
      : data.kind === "files" ? `<aside class="scope">${escape(t("这是多文件清单，不包含文件正文。"))}</aside>` : "";
  const body = data.kind === "folder" ? `<ul class="files">${data.entries.map(entry => `<li><code>${escape(entry)}</code></li>`).join("")}</ul>`
    : data.kind === "files" ? `<ul class="files">${data.files.map(file => `<li><strong>${escape(file.title)}</strong><br><code>${escape(file.address)}</code></li>`).join("")}</ul>`
      : renderedContent ?? markdown.render(data.content);
  // Content appears once in the article; the inert JSON block carries only scope and API guidance.
  const { content: _content, title: _title, background: _background, ...metadata } = { ...shareView(data, detail), content: "content" in data ? data.content : undefined };
  const context = JSON.stringify({ ...metadata, api: { read: route, ...((data.kind === "text" || data.kind === "file") ? { update: `/api/shares/${data.shareId}` } : {}) } })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const details = detail ? `<section class="details"><h2>${escape(t("详细信息"))}</h2><dl><dt>${escape(t("更新时间"))}</dt><dd><time>${escape(data.updated)}</time></dd>${"filePath" in data ? `<dt>${escape(t("本地路径"))}</dt><dd><code>${escape(data.filePath)}</code></dd>` : data.files.map(file => `<dt>${escape(file.title)}</dt><dd><code>${escape(file.filePath)}</code></dd>`).join("")}</dl></section>` : "";
  return `<!doctype html>
<html lang="${language() === "en" ? "en" : "zh-CN"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(data.title)} · agentNote</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--ink:#282330;--muted:#756c80;--line:#e5dfeb;--soft:#f8f5fc;--accent:#7443b7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;overflow-wrap:anywhere}main{max-width:860px;margin:auto;padding:28px 32px 56px}header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:20px}.brand{font-size:17px;font-weight:750;color:var(--accent)}.actions{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:13px}a{color:var(--accent)}a.open{padding:7px 14px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none}.kind{display:block;font-size:12px;color:var(--muted);margin-top:30px}h1{font-size:30px;line-height:1.35;letter-spacing:-.03em;margin:9px 0 28px}h2{font-size:21px;line-height:1.4;margin-top:30px}h3{font-size:18px}p,ul,ol,pre,blockquote,table{margin-top:0;margin-bottom:18px}article{min-width:0}article>:first-child{margin-top:0}pre{overflow:auto;padding:16px;background:var(--soft);border-radius:8px;overflow-wrap:normal}code{font:0.88em/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}blockquote{border-left:3px solid var(--line);padding-left:18px;color:var(--muted);margin-left:0}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}th,td{border:1px solid var(--line);padding:8px 12px}img{max-width:100%;height:auto}.callout{padding:14px 18px;background:var(--soft);border-left:3px solid var(--accent);border-radius:8px;margin-bottom:18px}.callout-title{font-weight:650}.callout-content>:last-child{margin-bottom:0}.unavailable-embed{color:var(--muted)}.background,.scope{padding:14px 18px;background:var(--soft);border-radius:9px;margin-bottom:24px}.background h2{font-size:12px;color:var(--muted);margin:0 0 6px}.background p:last-child{margin-bottom:0}.scope{font-size:14px;border-left:3px solid var(--accent)}.files{padding-left:22px}.files li{padding:8px 0}.details{border-top:1px solid var(--line);margin-top:32px;font-size:13px}.details h2{font-size:16px}.details dt{color:var(--muted)}.details dd{margin:0 0 12px}footer{border-top:1px solid var(--line);margin-top:40px;padding-top:16px;color:var(--muted);font-size:12px}footer a{margin-right:16px}@media(prefers-color-scheme:dark){:root{--bg:#1b1820;--ink:#eee8f5;--muted:#aaa0b6;--line:#3b3444;--soft:#27212f;--accent:#bc91f1}a.open{background:#8652cf;color:#fff}}@media(max-width:600px){main{padding:20px 20px 36px}h1{font-size:25px}}
</style></head><body><main><header><span class="brand">agentNote</span><nav class="actions">${open ? `<a class="open" href="${escape(open)}">${escape(t("在 Obsidian 中打开"))}</a>` : ""}<a href="${route}${detail ? "" : "?detail=1"}">${escape(detail ? t("简洁模式") : t("详细信息"))}</a></nav></header><span class="kind">${escape(kind)}</span><h1>${escape(data.title)}</h1>${scope}${background}<article>${body}</article>${details}<footer><a href="${route}?raw=1">${escape(t("纯文本"))}</a><a href="${route}?format=json${detail ? "&amp;detail=1" : ""}">JSON</a><span>${escape(t("本机分享 · 内容随原笔记更新"))}</span></footer></main><script type="application/json" id="agentnote-context">${context}</script></body></html>`;
}
