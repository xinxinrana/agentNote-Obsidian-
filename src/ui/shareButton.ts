import { setIcon } from "obsidian";
import { t } from "../i18n";

type ShareFormat = "link" | "pdf" | "html";
interface ShareButtonOptions {
  share(format: ShareFormat): Promise<boolean>;
}

/** One primary action, with alternate formats in a light-dismissable top-layer menu. */
export function renderShareButton(parent: HTMLElement, options: ShareButtonOptions): HTMLElement {
  let busy = false;
  let resetTimer: number | undefined;
  const formats: { id: ShareFormat; icon: string; title: string; detail: string }[] = [
    { id: "link", icon: "link", title: t("复制 Agent 链接"), detail: t("供本机 Agent 读取与写回") },
    { id: "pdf", icon: "file-text", title: t("复制 PDF 文件"), detail: t("适合发送、阅读和打印") },
    { id: "html", icon: "file-code", title: t("复制 HTML 文件"), detail: t("携带图片，浏览器直接打开") },
  ];
  const control = parent.createDiv({ cls: "agentnote-share-split" });
  const primary = control.createEl("button", { cls: "agentnote-share-primary", attr: { type: "button" } });
  const icon = primary.createSpan({ cls: "agentnote-share-action-icon", attr: { "aria-hidden": "true" } });
  const label = primary.createSpan({ text: t("分享当前笔记") });
  const toggle = control.createEl("button", { cls: "agentnote-share-toggle", attr: { type: "button", "aria-label": t("更多分享方式"), "aria-haspopup": "menu", "aria-expanded": "false" } });
  setIcon(toggle, "chevron-down");
  const menu = control.createDiv({ cls: "agentnote-share-menu", attr: { id: `agentnote-share-${crypto.randomUUID()}`, popover: "auto", role: "menu", "aria-label": t("更多分享方式") } });
  toggle.setAttribute("aria-controls", menu.id);
  menu.createDiv({ cls: "agentnote-share-menu-heading", text: t("更多分享方式") });
  const items: HTMLButtonElement[] = [];
  const close = () => { if (menu.matches(":popover-open")) menu.hidePopover(); };
  const reset = () => {
    label.setText(t("分享当前笔记"));
    setIcon(icon, "link");
    control.removeClass("is-complete");
  };
  formats.forEach(format => {
    const item = menu.createEl("button", { cls: "agentnote-share-option", attr: { type: "button", role: "menuitem", "data-format": format.id } });
    const glyph = item.createSpan({ cls: "agentnote-share-option-icon", attr: { "aria-hidden": "true" } });
    setIcon(glyph, format.icon);
    const text = item.createSpan({ cls: "agentnote-share-option-copy" });
    text.createSpan({ cls: "agentnote-share-option-title", text: format.title });
    text.createSpan({ cls: "agentnote-share-option-detail", text: format.detail });
    item.tabIndex = -1;
    item.onclick = () => run(format.id);
    items.push(item);
  });
  menu.addEventListener("toggle", () => toggle.setAttribute("aria-expanded", String(menu.matches(":popover-open"))));
  menu.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); close(); toggle.focus(); return; }
    if (event.key === "Tab") { close(); return; }
    const current = items.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : event.key === "ArrowUp" ? (current - 1 + items.length) % items.length : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  };
  const open = () => {
    if (busy) return;
    const rect = control.getBoundingClientRect();
    const width = Math.min(310, Math.max(250, rect.width), window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    menu.style.top = `${rect.bottom + 8}px`;
    menu.showPopover();
    const height = menu.getBoundingClientRect().height;
    menu.style.top = `${Math.max(12, rect.bottom + height + 20 > window.innerHeight ? rect.top - height - 8 : rect.bottom + 8)}px`;
    items[0].focus();
  };
  toggle.onclick = () => { if (menu.matches(":popover-open")) close(); else open(); };
  toggle.onkeydown = event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!menu.matches(":popover-open")) open();
    items[event.key === "ArrowUp" ? items.length - 1 : 0].focus();
  };
  const run = async (format: ShareFormat) => {
    if (busy) return;
    busy = true;
    if (resetTimer !== undefined) window.clearTimeout(resetTimer);
    close();
    toggle.focus();
    control.removeClass("is-complete");
    control.addClass("is-busy");
    primary.disabled = toggle.disabled = true;
    primary.setAttribute("aria-busy", "true");
    label.setText(format === "link" ? t("正在复制链接…") : t("正在生成文件…"));
    let shared = false;
    try { shared = await options.share(format); }
    finally {
      busy = false;
      control.removeClass("is-busy");
      primary.disabled = toggle.disabled = false;
      primary.setAttribute("aria-busy", "false");
      reset();
      if (shared) {
        setIcon(icon, "check");
        label.setText(format === "link" ? t("链接已复制") : t("文件已复制"));
        control.addClass("is-complete");
        resetTimer = window.setTimeout(() => { if (control.isConnected) reset(); }, 2500);
      }
    }
  };
  primary.onclick = () => run("link");
  reset();
  return control;
}
