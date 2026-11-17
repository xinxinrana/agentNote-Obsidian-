import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { language, t } from "../i18n";
import { escapeHtml, imageMime, prepareShareMarkdown, restoreShareSlots, readInlineImage } from "./shareMarkdown";
import { exportStyles } from "./exportStyles";
import agentNoteLogo from "../../assets/brand/xiaoji-mark.svg";
import { shareBrand, shareBrandStyles } from "./shareBrand";

export type ExportFormat = "pdf" | "html" | "md";
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
    let data: { bytes: Uint8Array; mime: string } | null;
    if (/^data:/i.test(image.link)) {
      data = readInlineImage(image.link);
      if (!data) throw new Error(t("内嵌图片无效、格式不支持或超过 20 MiB，无法导出。"));
    } else {
      if (!imageMime(image.link) || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(image.link)) throw new Error(t("请先将网络图片保存到笔记库后再导出：{0}", image.link));
      data = await renderer.readImage(image.link, source.sourcePath);
      if (!data || data.mime !== imageMime(image.link)) throw new Error(t("图片无法导出：{0}", image.link));
    }
    totalBytes += data.bytes.byteLength;
    if (totalBytes > 50 * 1024 * 1024) throw new Error(t("导出图片总大小超过 50 MiB，请缩小图片后重试。"));
    images.set(image.link, `data:${data.mime};base64,${Buffer.from(data.bytes).toString("base64")}`);
  }
  const rendered = await renderer.renderMarkdown(prepared.markdown, source.sourcePath);
  const body = restoreShareSlots(rendered, prepared, "", images).replaceAll('loading="lazy"', 'loading="eager"');
  return `<!doctype html><html lang="${language() === "en" ? "en" : "zh-CN"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(source.title)}</title><style>${exportStyles}${shareBrandStyles}</style></head><body><main><header class="document-header"><div class="document-brand"><img src="${escapeHtml(agentNoteLogo)}" alt="" width="25" height="25"><strong>agentNote</strong><span>${escapeHtml(t("笔记导出"))}</span></div><h1>${escapeHtml(source.title)}</h1><div class="document-rule" aria-hidden="true"></div>${source.selection ? `<p class="document-scope">${escapeHtml(t("这是分享的选段，不是全文。"))}</p>` : ""}</header><article>${body}</article><footer>${shareBrand()}</footer></main></body></html>`;
}

/** Keep the file after copying: native file clipboards reference a path until paste. */
export async function writeExportFile(title: string, format: ExportFormat, content: string, printPdf: (sourceFile: string) => Promise<Uint8Array>, directory = path.join(os.tmpdir(), "agentnote-exports")): Promise<string> {
  if (format !== "html" && format !== "pdf" && format !== "md") throw new Error("Unsupported export format");
  let name = Array.from(title, character => character.charCodeAt(0) < 32 ? "_" : character).join("").replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "note";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await fs.mkdtemp(path.join(directory, "share-"));
  const sourceFile = path.join(folder, `${name}.${format === "md" ? "md" : "html"}`);
  try {
    await fs.writeFile(sourceFile, content, { flag: "wx", mode: 0o600 });
    if (format !== "pdf") return sourceFile;
    const bytes = await printPdf(sourceFile);
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error(t("PDF 生成失败，请重试。"));
    const pdfPath = path.join(folder, `${name}.pdf`);
    await fs.writeFile(pdfPath, bytes, { flag: "wx", mode: 0o600 });
    await fs.rm(sourceFile);
    return pdfPath;
  } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
}

type CommandRunner = (command: string, args: string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<string | void>;
export type FileClipboardTarget = "win32" | "wayland" | "x11";
const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, { env: options.env ?? process.env, timeout: 15000, windowsHide: true }, (error, stdout) => { if (error) reject(error instanceof Error ? error : new Error(String(error))); else resolve(stdout); });
  // xclip reads the file URI from stdin, never from a shell command.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.input);
});

/** Copy the file itself, rather than its text, HTML markup or path string. */
export async function copyExportFile(file: string, platform: NodeJS.Platform = process.platform, run: CommandRunner = runCommand): Promise<FileClipboardTarget> {
  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Set-Clipboard -LiteralPath $env:AGENTNOTE_EXPORT_FILE"], { env: { ...process.env, AGENTNOTE_EXPORT_FILE: file } });
    return "win32";
  }
  if (platform === "linux") {
    const uri = `${pathToFileURL(file).href}\r\n`;
    try { await run("wl-copy", ["--type", "text/uri-list"], { input: uri }); return "wayland"; }
    catch { await run("xclip", ["-selection", "clipboard", "-t", "text/uri-list"], { input: uri }); return "x11"; }
  }
  throw new Error(t("当前平台暂不支持复制文件。"));
}

/** Read independently from the exact clipboard backend that received the file. */
export async function verifyExportFile(file: string, target: FileClipboardTarget, run: CommandRunner = runCommand): Promise<boolean> {
  try {
    if (target === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; $files = @(Get-Clipboard -Format FileDropList); if ($files.Count -ne 1 -or -not [String]::Equals($files[0].FullName, $env:AGENTNOTE_EXPORT_FILE, [StringComparison]::OrdinalIgnoreCase)) { throw 'Clipboard file mismatch' }"], { env: { ...process.env, AGENTNOTE_EXPORT_FILE: file } });
      return true;
    }
    const output = target === "wayland"
      ? await run("wl-paste", ["--no-newline", "--type", "text/uri-list"])
      : await run("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]);
    if (typeof output !== "string") return false;
    const files = output.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
    return files.length === 1 && path.resolve(fileURLToPath(files[0])) === path.resolve(file);
  } catch { return false; }
}

/** A successful write alone is never enough to report success to the user. */
export async function copyExportFileAndVerify(file: string, write = copyExportFile, verify = verifyExportFile): Promise<boolean> {
  try { const target = await write(file); return await verify(file, target); }
  catch { return false; }
}

export interface MacFileClipboard {
  writeBuffer(format: string, buffer: Buffer): void;
  readBuffer(format: string): Uint8Array;
}
/** Keep writing and verification separate, within Obsidian's own Electron process. */
export function writeMacFileClipboard(file: string, clipboard: MacFileClipboard): void {
  clipboard.writeBuffer("public.file-url", Buffer.from(pathToFileURL(file).href, "utf8"));
}
export function verifyMacFileClipboard(file: string, clipboard: MacFileClipboard): boolean {
  try {
    let uri = Buffer.from(clipboard.readBuffer("public.file-url")).toString("utf8");
    while (uri.endsWith(String.fromCharCode(0))) uri = uri.slice(0, -1);
    return path.resolve(fileURLToPath(uri)) === path.resolve(file);
  } catch { return false; }
}
