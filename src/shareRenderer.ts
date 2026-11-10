import { App, Component, MarkdownRenderer } from "obsidian";
import * as fs from "fs/promises";
import * as path from "path";
import { imageMime } from "./core/shareMarkdown";

const allowedTags = new Set("P DIV SPAN A EM STRONG B I S DEL MARK BLOCKQUOTE H1 H2 H3 H4 H5 H6 UL OL LI PRE CODE TABLE THEAD TBODY TFOOT TR TH TD BR HR SUP SUB DL DT DD INPUT".split(" "));
const removeTags = new Set("SCRIPT STYLE IFRAME OBJECT EMBED FORM BUTTON IMG SVG MATH LINK META BASE VIDEO AUDIO SOURCE".split(" "));

/** Export static reading content, without host callbacks, resource URLs or UI controls. */
export function cleanShareHtml(root: HTMLElement): string {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (removeTags.has(element.tagName)) { element.remove(); continue; }
    if (!allowedTags.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); continue; }
    const type = element.getAttribute("type");
    const checked = element.hasAttribute("checked");
    for (const attribute of Array.from(element.attributes)) {
      const { name, value } = attribute;
      if (name === "class" || name === "title" || name === "data-callout" || name === "data-callout-fold" || name === "colspan" || name === "rowspan" || name === "start") continue;
      if (name === "href" && /^(?:https?:\/\/|mailto:|#)/i.test(value)) continue;
      element.removeAttribute(name);
    }
    if (element.tagName === "INPUT") {
      if (type !== "checkbox") { element.remove(); continue; }
      element.setAttribute("type", "checkbox");
      element.setAttribute("disabled", "");
      if (checked) element.setAttribute("checked", "");
    }
    if (element.tagName === "A" && element.hasAttribute("href")) element.setAttribute("rel", "noopener noreferrer");
  }
  return root.innerHTML;
}

export function createShareRenderer(app: App, parent: Component) {
  return async (markdown: string, sourcePath: string): Promise<string> => {
    const component = parent.addChild(new Component());
    const host = document.body.createDiv({ cls: "markdown-rendered agentnote-share-render-host" });
    try {
      // Image/note embeds and executable code processors are masked before reaching this API.
      await MarkdownRenderer.render(app, markdown, host, sourcePath, component);
      return cleanShareHtml(host);
    } finally {
      host.remove();
      parent.removeChild(component);
    }
  };
}

/** Resolve like Obsidian, then enforce containment on disk (including symlinks). */
export async function readShareImage(app: App, root: string, link: string, sourcePath: string) {
  const target = app.metadataCache.getFirstLinkpathDest(link, sourcePath);
  if (!target) return null;
  const mime = imageMime(target.path);
  if (!mime || mime !== imageMime(link)) return null;
  const relative = target.path.replace(/\\/g, "/");
  const configDir = app.vault.configDir.replace(/\\/g, "/");
  if (relative === configDir || relative.startsWith(`${configDir}/`) || relative.split("/").some(part => part.startsWith("."))) return null;
  let handle: fs.FileHandle | undefined;
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(path.join(root, relative));
    const within = path.relative(realRoot, realFile);
    if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return null;
    handle = await fs.open(realFile, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return null;
    return { bytes: await handle.readFile(), mime };
  } catch { return null; }
  finally { await handle?.close(); }
}
