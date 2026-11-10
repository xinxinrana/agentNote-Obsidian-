import type { App, Component } from "obsidian";
import { buildExportHtml, copyExportFileAndVerify, writeExportFile, writeMacFileClipboard, verifyMacFileClipboard } from "./core/noteExport";
import type { MacFileClipboard, ExportFormat } from "./core/noteExport";
import { createShareRenderer, readShareImage } from "./shareRenderer";
import { t } from "./i18n";

interface PdfWindow {
  loadFile(file: string): Promise<void>;
  destroy(): void;
  webContents: {
    printToPDF(options: { printBackground: boolean; pageSize: string; preferCSSPageSize: boolean; displayHeaderFooter: boolean; margins: { top: number; bottom: number; left: number; right: number } }): Promise<Uint8Array>;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: string, handler: (event: { preventDefault(): void }) => void): void;
  };
}
interface ElectronRemote { BrowserWindow: new (options: object) => PdfWindow }

export async function printExportPdf(htmlPath: string): Promise<Uint8Array> {
  let remote: ElectronRemote;
  try {
    const electron = require("electron") as { remote?: ElectronRemote };
    remote = electron.remote ?? require("@electron/remote") as ElectronRemote;
  } catch { throw new Error(t("当前 Obsidian 无法生成 PDF，请重启后重试。")); }
  if (!remote?.BrowserWindow) throw new Error(t("当前 Obsidian 无法生成 PDF，请重启后重试。"));
  const win = new remote.BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false, backgroundThrottling: false } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    return await Promise.race([
      (async () => {
        await win.loadFile(htmlPath);
        return win.webContents.printToPDF({ printBackground: true, pageSize: "A4", preferCSSPageSize: true, displayHeaderFooter: false, margins: { top: 0.55, bottom: 0.55, left: 0.55, right: 0.55 } });
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t("PDF 生成超时，请重试。"))), 30000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); win.destroy(); }
}

/** Use the host clipboard on macOS; subprocess pasteboard access can differ from the host. */
export async function copyExportedFile(file: string): Promise<boolean> {
  if (process.platform !== "darwin") return copyExportFileAndVerify(file);
  try {
    const electron = require("electron") as { clipboard?: MacFileClipboard; remote?: { clipboard?: MacFileClipboard } };
    const clipboard = electron.clipboard ?? electron.remote?.clipboard ?? (require("@electron/remote") as { clipboard?: MacFileClipboard }).clipboard;
    if (!clipboard?.writeBuffer || !clipboard?.readBuffer) throw new Error("Native file clipboard unavailable");
    writeMacFileClipboard(file, clipboard);
    const copied = verifyMacFileClipboard(file, clipboard);
    if (!copied) console.warn("agentNote: native file clipboard verification failed");
    return copied;
  } catch (error) {
    console.warn("agentNote: native file clipboard write failed", error);
    return false;
  }
}

export async function exportNoteFile(app: App, parent: Component, root: string, sourcePath: string, format: ExportFormat, selection?: string): Promise<{ file: string; copied: boolean }> {
  const source = app.vault.getFileByPath(sourcePath);
  if (!source || source.extension.toLowerCase() !== "md") throw new Error(t("请选择 Markdown 笔记导出。"));
  const content = selection ?? await app.vault.cachedRead(source);
  if (!content.trim()) throw new Error(t("笔记内容为空，无法导出。"));
  const html = await buildExportHtml({ title: source.basename, content, sourcePath, selection: selection !== undefined }, { renderMarkdown: createShareRenderer(app, parent), readImage: (link, originalPath) => readShareImage(app, root, link, originalPath) });
  const file = await writeExportFile(source.basename, format, html, printExportPdf);
  return { file, copied: await copyExportedFile(file) };
}
