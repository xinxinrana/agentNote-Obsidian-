import { Modal, Setting } from "obsidian";
import type AgentNotePlugin from "../main";
import type { ExportFormat } from "../core/noteExport";
import { t } from "../i18n";

export class ExportNoteModal extends Modal {
  private format: ExportFormat = "pdf";
  constructor(private plugin: AgentNotePlugin, private sourcePath: string, private selection?: string) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("导出文件分享") });
    this.contentEl.createEl("p", { text: t("选择 PDF 或 HTML，生成的文件会复制到剪贴板，可直接粘贴发送。") });
    this.contentEl.createEl("p", { text: t("笔记库中的图片会随文件一起导出，无需启动本地服务。") });
    new Setting(this.contentEl).setName(t("文件格式")).addDropdown(dropdown => dropdown.addOptions({ pdf: "PDF", html: "HTML" }).setValue(this.format).onChange(value => { this.format = value as ExportFormat; }));
    const button = this.contentEl.createEl("button", { cls: "mod-cta", text: t("生成并复制文件") });
    button.onclick = async () => {
      button.disabled = true;
      button.setText(t("正在生成文件…"));
      try { if (await this.plugin.exportFileFromPanel(this.sourcePath, this.format, this.selection)) this.close(); }
      finally { button.disabled = false; button.setText(t("生成并复制文件")); }
    };
  }
  onClose(): void { this.contentEl.empty(); }
}
