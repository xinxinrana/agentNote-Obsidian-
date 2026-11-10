import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { pathToFileURL } from "url";
import { language, t } from "../i18n";
import { escapeHtml, imageMime, prepareShareMarkdown, restoreShareSlots } from "./shareMarkdown";
import { sharePageStyles } from "./sharePage";

export type ExportFormat = "pdf" | "html";
export interface ExportSource { title: string; content: string; sourcePath: string; selection?: boolean }
export interface ExportRenderer {
  renderMarkdown(markdown: string, sourcePath: string): Promise<string>;
  readImage(link: string, sourcePath: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

/** A portable file contains only its selected content, styles and embedded image bytes. */
export async function buildExportHtml(source: ExportSource, renderer: ExportRenderer): Promise<string> {
  const prepared = prepareShareMarkdown(source.content);
  const images = new Map<string, string>();
  let totalBytes = 0;
  for (const slot of prepared.slots) {
    const image = slot.image;
    if (!image || images.has(image.link)) continue;
    if (!imageMime(image.link) || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(image.link)) throw new Error(t("请先将网络图片保存到笔记库后再导出：{0}", image.link));
    const data = await renderer.readImage(image.link, source.sourcePath);
    if (!data || data.mime !== imageMime(image.link)) throw new Error(t("图片无法导出：{0}", image.link));
    totalBytes += data.bytes.byteLength;
    if (totalBytes > 50 * 1024 * 1024) throw new Error(t("导出图片总大小超过 50 MiB，请缩小图片后重试。"));
    images.set(image.link, `data:${data.mime};base64,${Buffer.from(data.bytes).toString("base64")}`);
  }
  const rendered = await renderer.renderMarkdown(prepared.markdown, source.sourcePath);
  const body = restoreShareSlots(rendered, prepared, "", images).replaceAll('loading="lazy"', 'loading="eager"');
  return `<!doctype html><html lang="${language() === "en" ? "en" : "zh-CN"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(source.title)}</title><style>${sharePageStyles}
:root{color-scheme:light;--bg:#fff;--ink:#282330;--muted:#756c80;--line:#e5dfeb;--soft:#f8f5fc;--accent:#7443b7}body{background:#fff;color:#282330}header{display:block}header h1{margin:0}article{margin-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{object-fit:contain}thead{display:table-header-group}
@page{size:A4;margin:14mm}
@media print{main{max-width:none;padding:0}header{padding-bottom:12px}h1,h2,h3{break-after:avoid}pre,blockquote,.callout,tr,img{break-inside:avoid}pre{overflow:visible}table{display:table;width:100%;font-size:12px;break-inside:avoid}td,th{overflow-wrap:anywhere}img{max-height:240mm}a{color:inherit}body{font-size:12px}h1{font-size:25px}}
</style></head><body><main><header><h1>${escapeHtml(source.title)}</h1>${source.selection ? `<p>${escapeHtml(t("这是分享的选段，不是全文。"))}</p>` : ""}</header><article>${body}</article></main></body></html>`;
}

/** Keep the file after copying: native file clipboards reference a path until paste. */
export async function writeExportFile(title: string, format: ExportFormat, html: string, printPdf: (htmlPath: string) => Promise<Uint8Array>, directory = path.join(os.tmpdir(), "agentnote-exports")): Promise<string> {
  if (format !== "html" && format !== "pdf") throw new Error("Unsupported export format");
  let name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "note";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.mkdtemp(path.join(directory, "share-"));
  const htmlPath = path.join(folder, `${name}.html`);
  try {
    await fs.writeFile(htmlPath, html, { flag: "wx", mode: 0o600 });
    if (format === "html") return htmlPath;
    const bytes = await printPdf(htmlPath);
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error(t("PDF 生成失败，请重试。"));
    const pdfPath = path.join(folder, `${name}.pdf`);
    await fs.writeFile(pdfPath, bytes, { flag: "wx", mode: 0o600 });
    await fs.rm(htmlPath);
    return pdfPath;
  } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
}

type CommandRunner = (command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<void>;
const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { env: options.env ?? process.env, timeout: 15000, windowsHide: true }, error => error ? reject(error) : resolve());
  // xclip reads the file URI from stdin, never from a shell command.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.input);
});

/** Copy the file itself, rather than its text, HTML markup or path string. */
export async function copyExportFile(file: string, platform: NodeJS.Platform = process.platform, run: CommandRunner = runCommand): Promise<void> {
  if (platform === "darwin") {
    await run("/usr/bin/osascript", ["-e", "on run argv\nset the clipboard to (POSIX file (item 1 of argv)) as alias\nend run", file]);
  } else if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Set-Clipboard -LiteralPath $env:AGENTNOTE_EXPORT_FILE"], { env: { ...process.env, AGENTNOTE_EXPORT_FILE: file } });
  } else if (platform === "linux") {
    const uri = `${pathToFileURL(file).href}\r\n`;
    try { await run("wl-copy", ["--type", "text/uri-list"], { input: uri }); }
    catch { await run("xclip", ["-selection", "clipboard", "-t", "text/uri-list"], { input: uri }); }
  } else throw new Error(t("当前平台暂不支持复制文件。"));
}
