import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type AgentNotePlugin from "../main";
import type { ExportFormat } from "../core/noteExport";
import { t } from "../i18n";

export class ExportNoteModal extends Modal {
  private format: ExportFormat = "pdf";
  constructor(private plugin: AgentNotePlugin, private sourcePath: string, private selection?: string) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("导出文件分享") });
    this.contentEl.createEl("p", { text: t("选择 PDF、HTML 或 Markdown，生成的文件会复制到剪贴板，可直接粘贴发送。") });
    this.contentEl.createEl("p", { text: t("PDF 和 HTML 携带笔记库中的图片；Markdown 保留原文和图片引用地址。") });
    new Setting(this.contentEl).setName(t("文件格式")).addDropdown(dropdown => dropdown.addOptions({ pdf: "PDF", html: "HTML", md: "Markdown" }).setValue(this.format).onChange(value => { this.format = value as ExportFormat; }));
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

export class MarkdownExportNotice extends Modal {
  private remember = false;
  private decided = false;
  constructor(app: App, private done: (accepted: boolean, remember: boolean) => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: t("Markdown 图片说明") });
    this.contentEl.createEl("p", { text: t("Markdown 文件仅保留原文和图片引用地址，不包含图片文件。笔记库中的图片无法在他人的设备上直接显示；需要先上传到图床等可访问的位置，并在原文中使用对应链接。") });
    new Setting(this.contentEl).setName(t("不再提示")).addToggle(toggle => toggle.onChange(value => { this.remember = value; }));
    const actions = this.contentEl.createDiv({ cls: "agentnote-bulk-actions" });
    actions.createEl("button", { text: t("取消") }).onclick = () => this.close();
    actions.createEl("button", { text: t("我已知晓"), cls: "mod-cta" }).onclick = () => {
      if (this.decided) return;
      this.decided = true;
      this.done(true, this.remember);
      this.close();
    };
  }
  onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.done(false, false);
    }
    this.contentEl.empty();
  }
}
