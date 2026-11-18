// Keep screen and print typography identical while measuring a continuous page.
export const continuousStyles = `
@page{size:auto!important;margin:0!important}
html,body{width:210mm!important;height:auto!important;min-height:0!important;overflow:visible!important}
body{font-size:11pt!important;line-height:1.8!important}
main.agentnote-export-document{box-sizing:border-box!important;width:210mm!important;max-width:none!important;margin:0!important;padding:18mm!important}
.document-header{margin-bottom:24px!important}.document-header h1{font-size:24pt!important}.document-brand{font-size:8pt!important}.document-brand strong{font-size:10pt!important}
article h1{font-size:19pt!important}h2{font-size:16pt!important}h3{font-size:13pt!important}h4,h5,h6{font-size:11pt!important}pre,table{font-size:9pt!important}footer{margin-top:28px!important}
.agentnote-export-document *{break-before:auto!important;break-after:auto!important;break-inside:auto!important;page-break-before:auto!important;page-break-after:auto!important;page-break-inside:auto!important}
`;


export function prepareContinuousHtml(html: string): string {
  return html.replace("</head>", `<style>${continuousStyles}</style></head>`);
}

/** Runs only in the isolated PDF renderer, never in Obsidian's workspace. */
export async function measureContinuousDocument(missingLabel: string): Promise<{ heightMm: number; failedImages: string[] }> {
  await document.fonts.ready;
  const failedImages: string[] = [];
  for (const image of Array.from(document.images)) {
    if (image.complete && image.naturalWidth > 0) continue;
    try { await image.decode(); } catch { /* Check actual drawable pixels instead of relying on decode() alone. */ }
    if (image.naturalWidth > 0) continue;
    const name = image.getAttribute("data-export-image") || image.alt || String(failedImages.length + 1);
    if (image.closest("article")) {
      const placeholder = document.createElement("span");
      placeholder.textContent = `${missingLabel} ${name}`;
      placeholder.className = "unavailable-embed";
      image.replaceWith(placeholder);
      failedImages.push(name);
    } else image.remove();
  }
  const main = document.querySelector("main.agentnote-export-document");
  if (!main) throw new Error("LAYOUT_UNAVAILABLE");
  const pixels = Math.ceil(Math.max(main.getBoundingClientRect().height, main.scrollHeight, document.body.scrollHeight)) + 4;
  if (!Number.isFinite(pixels) || pixels <= 4 || pixels > 200 * 96) throw new Error("PAGE_TOO_LONG");
  const heightMm = Math.ceil(pixels / 96 * 25.4 * 100) / 100;
  return { heightMm, failedImages };
}
