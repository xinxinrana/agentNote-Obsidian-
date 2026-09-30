import * as path from "path";
import { parse as parseYaml } from "yaml";
import brandImage from "../../assets/brand/png/agentnote-lockup.png";
import brandIcon from "../../assets/brand/png/xiaoji-mark.png";
import type { ShareResult } from "./store";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const decodeImage = (dataUrl: string): Buffer => Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

export function shareCardImage(): Buffer { return decodeImage(brandImage); }
export function shareFavicon(): Buffer { return decodeImage(brandIcon); }

function embeddedBackground(content: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.trimStart());
  if (!frontmatter) return "";
  try {
    const parsed: unknown = parseYaml(frontmatter[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "背景" in parsed && typeof parsed.背景 === "string") return parsed.背景;
  } catch { return ""; }
  return "";
}

export function renderSharePage(data: ShareResult, origin: string, vaultRoot: string, nonce: string): string {
  const pageUrl = `${origin}/shares/${encodeURIComponent(data.shareId)}`;
  const imageUrl = `${origin}/share-card.png`;
  const iconUrl = `${origin}/share-icon.png`;
  const kind = data.kind === "folder" ? "文件夹" : data.kind === "file" ? "文件" : "笔记";
  const background = data.background.trim() || (data.kind === "folder" ? "" : embeddedBackground(data.content).trim());
  const description = (background.replace(/\s+/g, " ").trim().slice(0, 150) || `通过 agentNote 分享的本地${kind}，可由已接入的 agent 读取。`);
  const relativePath = path.relative(vaultRoot, data.filePath);
  const canOpenInObsidian = data.kind !== "folder" && relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
  const obsidianUrl = canOpenInObsidian ? `obsidian://open?path=${encodeURIComponent(data.filePath)}` : null;
  const title = escapeHtml(data.title);
  const summary = escapeHtml(description);
  const openButton = obsidianUrl ? `<a class="action primary" href="${escapeHtml(obsidianUrl)}">在 Obsidian 打开 <span aria-hidden="true">↗</span></a>` : "";
  const updated = new Date(data.updated);
  const updatedLabel = Number.isNaN(updated.getTime()) ? "" : `更新于 ${updated.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${summary}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="agentNote">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${summary}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1000">
  <meta property="og:image:height" content="260">
  <meta property="og:image:alt" content="agentNote · Local knowledge for agents">
  <link rel="icon" href="${escapeHtml(iconUrl)}" type="image/png">
  <title>${title} · agentNote</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; background: #f8f6fb; color: #211a2c; }
    .card { width: min(100%, 600px); padding: 30px 34px 24px; border: 1px solid #e9dff0; border-radius: 22px; background: #fff; box-shadow: 0 20px 70px rgba(72, 38, 100, .08); }
    .brand { display: flex; align-items: center; gap: 9px; color: #70459e; font-size: 13px; font-weight: 750; }
    .brand img { width: 28px; height: 28px; }
    .kind { display: inline-block; margin-top: 24px; padding: 5px 9px; border-radius: 7px; background: #f1e7fa; color: #7141a7; font-size: 12px; font-weight: 700; }
    h1 { margin: 14px 0 10px; font-size: clamp(24px, 5vw, 32px); line-height: 1.3; overflow-wrap: anywhere; }
    .summary { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; margin: 0; color: #655a70; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
    .updated { margin: 18px 0 0; color: #94879e; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 27px; padding-top: 22px; border-top: 1px solid #f0eaf3; }
    .action { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 40px; padding: 9px 14px; border: 1px solid #e7dceb; border-radius: 9px; background: #fff; color: #6f4694; font: inherit; font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; }
    .action.primary { border-color: #8e4dd0; background: #8e4dd0; color: #fff; }
    .action:hover { filter: brightness(.94); }
    .action:focus-visible { outline: 2px solid #8e4dd0; outline-offset: 3px; }
    .status { align-self: center; color: #7a6f83; font-size: 12px; }
    .footnote { margin: 18px 0 0; color: #96899e; font-size: 12px; }
    @media (max-width: 560px) { body { padding: 16px; } .card { padding: 24px 22px; } .actions { flex-direction: column; } .action { width: 100%; } }
    @media (prefers-color-scheme: dark) { body { background: #17131d; color: #f3eefa; } .card { background: #241b2d; border-color: #493650; } .kind { background: #3c2a4c; color: #d4a6fb; } .summary, .status { color: #c2b3cc; } .updated, .footnote { color: #ac9bb5; } .actions { border-color: #473651; } .action { background: #2e2238; border-color: #594566; color: #dbb9f9; } .action.primary { background: #9956d9; border-color: #9956d9; color: #fff; } .brand { color: #d5a5fa; } }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand"><img src="${escapeHtml(iconUrl)}" alt="" width="28" height="28"><span>agentNote · 本地分享</span></div>
    <span class="kind">${kind}</span>
    <h1>${title}</h1>
    <p class="summary">${summary}</p>
    ${updatedLabel ? `<p class="updated">${escapeHtml(updatedLabel)}</p>` : ""}
    <div class="actions">${openButton}<button class="action" id="copy" type="button">复制分享链接</button><span class="status" id="copy-status" role="status" aria-live="polite"></span></div>
    <p class="footnote">资料留在本机，Agent 使用 JSON 接口读取。</p>
  </main>
  <script nonce="${nonce}">
    document.getElementById("copy").addEventListener("click", async () => {
      const status = document.getElementById("copy-status");
      try { await navigator.clipboard.writeText(location.href); status.textContent = "已复制"; }
      catch { status.textContent = "复制失败，请复制地址栏链接"; }
    });
  </script>
</body>
</html>`;
}
