import { t } from "./i18n";

// Measure the same width, typography and padding used by Chromium's print layout.
const continuousStyles = `
@page{margin:0}
html,body{width:210mm!important;height:auto!important;min-height:0!important;overflow:visible!important}
body{font-size:11pt!important;line-height:1.8!important}
main.agentnote-export-document{box-sizing:border-box!important;width:210mm!important;max-width:none!important;margin:0!important;padding:18mm!important}
.document-header{margin-bottom:24px!important}.document-header h1{font-size:24pt!important}.document-brand{font-size:8pt!important}.document-brand strong{font-size:10pt!important}
article h1{font-size:19pt!important}h2{font-size:16pt!important}h3{font-size:13pt!important}h4,h5,h6{font-size:11pt!important}pre,table{font-size:9pt!important}footer{margin-top:28px!important}
.agentnote-export-document *{break-before:auto!important;break-after:auto!important;break-inside:auto!important;page-break-before:auto!important;page-break-after:auto!important;page-break-inside:auto!important}
`;

/** One content-sized PDF page; the measurement frame never executes note scripts. */
export async function continuousPdfHtml(html: string): Promise<string> {
  const content = html.replace("</head>", `<style>${continuousStyles}</style></head>`);
  const frame = document.createElement("iframe");
  frame.className = "agentnote-export-measure-frame";
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  let timer: number | undefined;
  try {
    const measured = (async () => {
      await new Promise<void>((resolve, reject) => {
        frame.onload = () => { if (frame.contentDocument?.querySelector("main.agentnote-export-document")) resolve(); };
        frame.onerror = () => reject(new Error(t("长页 PDF 排版失败，请重试。")));
        frame.srcdoc = content;
        document.body.append(frame);
      });
      const doc = frame.contentDocument;
      if (!doc) throw new Error(t("长页 PDF 排版失败，请重试。"));
      await doc.fonts.ready;
      await Promise.all(Array.from(doc.images, image => image.decode()));
      const main = doc.querySelector("main.agentnote-export-document");
      if (!main) throw new Error(t("长页 PDF 排版失败，请重试。"));
      const pixels = Math.ceil(Math.max(main.getBoundingClientRect().height, main.scrollHeight, doc.body.scrollHeight)) + 4;
      // Standard PDF page dimensions are limited to 200 inches without UserUnit scaling.
      if (!Number.isFinite(pixels) || pixels <= 4 || pixels > 200 * 96) throw new Error(t("内容超出单页 PDF 的尺寸上限，请使用官方分页导出。"));
      const heightMm = Math.ceil(pixels / 96 * 25.4 * 100) / 100;
      return content.replace("</head>", `<style>@page{size:210mm ${heightMm}mm;margin:0}</style></head>`);
    })();
    return await Promise.race([
      measured,
      new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error(t("长页 PDF 排版超时，请重试。"))), 15000); }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    frame.onload = frame.onerror = null;
    frame.remove();
  }
}
