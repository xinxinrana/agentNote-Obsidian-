import type { App, Component } from "obsidian";
import { buildExportHtml, copyExportFileAndVerify, writeExportFile, writeMacFileClipboard, verifyMacFileClipboard } from "./core/noteExport";
import type { MacFileClipboard, ExportFormat } from "./core/noteExport";
import { createShareRenderer, readShareImage } from "./shareRenderer";
import { prepareContinuousHtml, measureContinuousDocument } from "./continuousPdf";
import { renderNativePdfDocument } from "./nativePdfExperiment";
import { abortableExport, checkExport } from "./exportTask";
import type { ExportControl } from "./exportTask";
import { t } from "./i18n";

interface PdfWindow {
  loadFile(file: string): Promise<void>;
  destroy(): void;
  webContents: {
    debugger: { attach(version: string): void; detach(): void; sendCommand(method: string, params?: object): Promise<{ exceptionDetails?: unknown; result?: { value?: { heightMm: number; failedImages: string[] } } }> };
    printToPDF(options: { printBackground: boolean; pageSize: string | { width: number; height: number }; preferCSSPageSize: boolean; displayHeaderFooter: boolean; margins: { top: number; bottom: number; left: number; right: number } }): Promise<Uint8Array>;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: string, handler: (event: { preventDefault(): void }) => void): void;
  };
}
interface ElectronRemote { BrowserWindow: new (options: object) => PdfWindow }

export async function printExportPdf(htmlPath: string, options: { continuous?: boolean; control?: ExportControl } = {}): Promise<Uint8Array> {
  let remote: ElectronRemote;
  try {
    const electron = require("electron") as { remote?: ElectronRemote };
    remote = electron.remote ?? require("@electron/remote") as ElectronRemote;
  } catch { throw new Error(t("当前 Obsidian 无法生成 PDF，请重启后重试。")); }
  if (!remote?.BrowserWindow) throw new Error(t("当前 Obsidian 无法生成 PDF，请重启后重试。"));
  const win = new remote.BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false, backgroundThrottling: false } });
  let timer: number | undefined;
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    return await abortableExport(Promise.race([
      (async () => {
        await win.loadFile(htmlPath);
        checkExport(options.control);
        let pageSize: string | { width: number; height: number } = "A4";
        if (options.continuous) {
          options.control?.onProgress?.(t("正在排版长页，可继续阅读笔记…"));
          const debuggerApi = win.webContents.debugger;
          debuggerApi.attach("1.3");
          try {
            await debuggerApi.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
            const result = await debuggerApi.sendCommand("Runtime.evaluate", { expression: `(${measureContinuousDocument.toString()})(${JSON.stringify(t("图片无法显示："))})`, awaitPromise: true, returnByValue: true });
            if (result.exceptionDetails || !result.result?.value) {
              const detail = JSON.stringify(result.exceptionDetails);
              throw new Error(detail.includes("PAGE_TOO_LONG") ? t("内容超出单页 PDF 的尺寸上限，请使用官方分页导出。") : t("长页 PDF 排版失败，请重试。"));
            }
            pageSize = { width: 210 / 25.4, height: result.result.value.heightMm / 25.4 };
            for (const name of result.result.value.failedImages) options.control?.onWarning?.(name);
          } finally { debuggerApi.detach(); }
        }
        checkExport(options.control);
        options.control?.onProgress?.(t("正在生成 PDF，可继续阅读笔记…"));
        return win.webContents.printToPDF({ printBackground: true, pageSize, preferCSSPageSize: !options.continuous, displayHeaderFooter: false, margins: options.continuous ? { top: 0, bottom: 0, left: 0, right: 0 } : { top: 0.55, bottom: 0.55, left: 0.55, right: 0.55 } });
      })(),
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error(t("PDF 生成超时，请重试。"))), 120000); }),
    ]), options.control);
  } finally { if (timer) window.clearTimeout(timer); win.destroy(); }
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

export async function exportNoteFile(app: App, parent: Component, root: string, sourcePath: string, format: ExportFormat | "hybrid-pdf", selection?: string, control?: ExportControl): Promise<{ file: string; copied: boolean }> {
  checkExport(control);
  control?.onProgress?.(t("正在准备笔记…"));
  const source = app.vault.getFileByPath(sourcePath);
  if (!source || source.extension.toLowerCase() !== "md") throw new Error(t("请选择 Markdown 笔记导出。"));
  const content = selection ?? await app.vault.cachedRead(source);
  if (!content.trim()) throw new Error(t("笔记内容为空，无法导出。"));
  if (format === "hybrid-pdf" && selection !== undefined) throw new Error(t("融合导出仅支持整篇笔记。"));
  const output = format === "hybrid-pdf" ? prepareContinuousHtml(await renderNativePdfDocument(app, parent, sourcePath, control)) : format === "md" ? content : await buildExportHtml({ title: source.basename, content, sourcePath, selection: selection !== undefined }, { renderMarkdown: createShareRenderer(app, parent), readImage: (link, originalPath) => readShareImage(app, root, link, originalPath) });
  const file = await writeExportFile(source.basename, format === "hybrid-pdf" ? "pdf" : format, output, sourceFile => printExportPdf(sourceFile, { continuous: format === "hybrid-pdf", control }));
  checkExport(control);
  control?.onProgress?.(t("正在复制文件…"));
  return { file, copied: await copyExportedFile(file) };
}

/** Dispatch the installed host command after focusing the requested full note. */
export async function openNativePdfExport(app: App, sourcePath: string): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file || file.extension.toLowerCase() !== "md") throw new Error(t("请选择 Markdown 笔记导出。"));
  // Command dispatch is a host capability, not a public PDF conversion API.
  const commands = (app as App & { commands?: { executeCommandById(id: string): boolean } }).commands;
  if (!commands?.executeCommandById) throw new Error(t("当前 Obsidian 无法打开官方导出，请从笔记菜单选择导出为 PDF。"));
  const leaf = app.workspace.getLeavesOfType("markdown").find(leaf => (leaf.view as { file?: { path: string } }).file?.path === sourcePath) ?? app.workspace.getLeaf("tab");
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  if (!commands.executeCommandById("workspace:export-pdf")) throw new Error(t("当前 Obsidian 无法打开官方导出，请从笔记菜单选择导出为 PDF。"));
}
