import { t } from "../i18n";
import type { ExportControl } from "../exportTask";

/** A nonmodal, cancellable task card; no simulated percentages. */
export function showExportProgress(title: string, controller: AbortController): { control: ExportControl; close(): void } {
  const card = document.body.createDiv({ cls: "agentnote-export-task" });
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", t("文件导出进度"));
  card.createEl("div", { cls: "agentnote-export-task-heading", text: t("正在导出文件") });
  card.createEl("div", { cls: "agentnote-export-task-title", text: title });
  const status = card.createEl("div", { cls: "agentnote-export-task-status", text: t("正在准备笔记…"), attr: { role: "status", "aria-live": "polite" } });
  const progress = card.createEl("progress", { cls: "agentnote-export-task-progress", attr: { "aria-label": t("文件导出进度") } });
  const bottom = card.createDiv({ cls: "agentnote-export-task-bottom" });
  bottom.createEl("span", { text: t("可以继续阅读笔记") });
  const cancel = bottom.createEl("button", { text: t("取消导出"), attr: { type: "button" } });
  cancel.onclick = () => {
    controller.abort();
    cancel.disabled = true;
    status.textContent = t("正在取消…");
  };
  return {
    control: { signal: controller.signal, onProgress(message, completed, total) {
      if (controller.signal.aborted) return;
      status.textContent = message;
      if (total && completed !== undefined) { progress.max = total; progress.value = completed; }
      else progress.removeAttribute("value");
    } },
    close() { card.remove(); },
  };
}
