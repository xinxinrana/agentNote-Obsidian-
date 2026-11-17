import { Component, MarkdownRenderer, getFrontMatterInfo } from "obsidian";
import type { App } from "obsidian";
import { renderExportDocument } from "./core/noteExport";
import { t } from "./i18n";

/** Render full local content with the public host renderer, retaining native layout and resources. */
export async function renderNativePdfDocument(app: App, parent: Component, sourcePath: string): Promise<string> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file || file.extension.toLowerCase() !== "md") throw new Error(t("请选择 Markdown 笔记导出。"));
  const component = parent.addChild(new Component());
  const host = document.body.createDiv({ cls: "print agentnote-native-render-host" });
  try {
    const content = await app.vault.cachedRead(file);
    const rendered = host.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    const frontmatter: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
    if (frontmatter && typeof frontmatter === "object") {
      const value: unknown = (frontmatter as Record<string, unknown>).cssclasses ?? (frontmatter as Record<string, unknown>).cssclass;
      const classes = (Array.isArray(value) ? value : [value]).flatMap((item: unknown) => typeof item === "string" ? item.split(/\s+/).filter(Boolean) : []);
      if (classes.length) rendered.classList.add(...classes);
    }
    await MarkdownRenderer.render(app, content.slice(getFrontMatterInfo(content).contentStart), rendered, sourcePath, component);
    if (rendered.querySelector("iframe,object,embed")) throw new Error(t("融合导出暂不支持交互嵌入，请使用官方导出。"));
    const snapshot = rendered.cloneNode(true) as HTMLElement;
    const videos = Array.from(rendered.querySelectorAll("video"));
    snapshot.querySelectorAll("video,audio").forEach(media => {
      const figure = document.createElement("figure");
      if (media.tagName === "VIDEO") {
        const original = videos.shift();
        let poster = original?.poster;
        if (!poster && original && original.readyState >= 2 && original.videoWidth && original.videoHeight) {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = original.videoWidth;
            canvas.height = original.videoHeight;
            const context = canvas.getContext("2d");
            if (context) { context.drawImage(original, 0, 0); poster = canvas.toDataURL("image/png"); }
          } catch { /* Keep an explicit media label when no printable frame is available. */ }
        }
        if (poster) { const image = document.createElement("img"); image.src = poster; figure.append(image); }
      }
      const caption = document.createElement("figcaption");
      caption.textContent = media.tagName === "VIDEO" ? t("视频（请在原笔记中播放）") : t("音频（请在原笔记中播放）");
      figure.append(caption);
      media.replaceWith(figure);
    });
    const canvases = Array.from(rendered.querySelectorAll("canvas"));
    snapshot.querySelectorAll("canvas").forEach((canvas, index) => {
      const image = document.createElement("img");
      image.src = canvases[index].toDataURL("image/png");
      image.width = canvases[index].clientWidth || canvases[index].width;
      image.height = canvases[index].clientHeight || canvases[index].height;
      canvas.replaceWith(image);
    });
    snapshot.querySelectorAll("script,link,meta,base").forEach(element => element.remove());
    snapshot.querySelectorAll("*").forEach(element => {
      for (const attribute of Array.from(element.attributes)) if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    });
    const resources = new Map<string, Promise<string>>();
    let totalBytes = 0;
    const embed = (address: string, base: string): Promise<string> => {
      if (address.startsWith("data:") || address.startsWith("#")) return Promise.resolve(address);
      const uri = new URL(address, base);
      if (!["app:", "blob:"].includes(uri.protocol)) throw new Error(t("融合导出图片无法离线加载，请使用官方导出。"));
      let pending = resources.get(uri.href);
      if (!pending) {
        pending = (async () => {
          const response = await window.fetch(uri.href, { signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(t("融合导出资源读取失败，请使用官方导出。"));
          const bytes = new Uint8Array(await response.arrayBuffer());
          totalBytes += bytes.byteLength;
          if (bytes.byteLength > 20 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) throw new Error(t("融合导出资源过大，请使用官方导出。"));
          const mime = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
          return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
        })();
        resources.set(uri.href, pending);
      }
      return pending;
    };
    // Embed host resources before moving the content into the isolated PDF window.
    for (const image of Array.from(snapshot.querySelectorAll("img"))) {
      image.src = await embed(image.getAttribute("src") || "", document.baseURI);
      image.removeAttribute("srcset");
      image.loading = "eager";
    }
    for (const image of Array.from(snapshot.querySelectorAll("svg image"))) {
      const address = image.getAttribute("href") || image.getAttribute("xlink:href");
      if (address) { image.setAttribute("href", await embed(address, document.baseURI)); image.removeAttribute("xlink:href"); }
    }
    if (Array.from(snapshot.querySelectorAll("svg use")).some(element => {
      const address = element.getAttribute("href") || element.getAttribute("xlink:href");
      return address && !address.startsWith("#");
    })) throw new Error(t("融合导出暂不支持交互嵌入，请使用官方导出。"));
    const inlineStyle = async (css: string, base: string) => {
      const matches = Array.from(css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi));
      const values = await Promise.all(matches.map(match => embed(match[2], base)));
      let index = 0;
      return css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, () => `url("${values[index++]}")`);
    };
    const readStyles = async (sheet: CSSStyleSheet): Promise<string> => {
      const base = sheet.href || document.baseURI;
      const rules: string[] = [];
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === 3) {
          const imported = (rule as CSSImportRule).styleSheet;
          if (!imported) throw new Error(t("融合导出资源读取失败，请使用官方导出。"));
          rules.push(await readStyles(imported));
        } else rules.push(await inlineStyle(rule.cssText, base));
      }
      return rules.join("\n");
    };
    const styles = (await Promise.all(Array.from(document.styleSheets, sheet => readStyles(sheet)))).join("\n");
    for (const element of Array.from(snapshot.querySelectorAll<HTMLElement>("[style]"))) {
      element.setAttribute("style", await inlineStyle(element.getAttribute("style") || "", document.baseURI));
    }
    snapshot.querySelectorAll("style").forEach(element => element.remove());
    return renderExportDocument({ title: file.basename, content: "", sourcePath }, snapshot.outerHTML, styles + "\nbody{overflow:visible!important}.agentnote-export-document.print{position:static!important;inset:auto!important;display:block!important;width:auto!important;height:auto!important;overflow:visible!important}.markdown-preview-view{height:auto!important;overflow:visible!important;padding:0!important;width:100%!important;max-width:none!important}.markdown-preview-sizer{max-width:none!important;min-height:0!important}.agentnote-export-document .markdown-rendered blockquote{border:0!important;background:none!important;box-shadow:none!important}.agentnote-export-document .markdown-rendered .callout{background:none!important;border-left:0!important;border-radius:0!important}");
  } finally {
    host.remove();
    parent.removeChild(component);
  }
}
