import MarkdownIt from "markdown-it";
import { randomUUID } from "crypto";
import { t } from "../i18n";

const parser = new MarkdownIt({ html: true });
const staticMarkdown = new MarkdownIt({ html: false, linkify: false });
export const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const imageTypes = new Map(Object.entries({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" }));
export const imageMime = (link: string): string | undefined => imageTypes.get(link.split(".").pop()?.toLowerCase() ?? "");
export interface SharedImage { link: string; alt: string; width?: number; height?: number }
interface Edit { start: number; end: number; block?: boolean; html?: string; image?: SharedImage }

/** Accept embedded raster images, not arbitrary data documents or permissively decoded text. */
export function readInlineImage(link: string): { bytes: Buffer; mime: string } | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i.exec(link);
  if (!match || match[2].length > 28 * 1024 * 1024) return null;
  const encoded = match[2].replace(/[\t\n\r ]/g, "");
  if (!encoded || !/^[a-z\d+/]+={0,2}$/i.test(encoded) || encoded.length % 4 === 1) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return null;
  const mime = match[1].toLowerCase();
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/gif" ? /^(?:GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii"))
        : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return valid ? { bytes, mime } : null;
}

/** Read only a single img tag's source, text and numeric dimensions. Never forward HTML attributes. */
function htmlImage(tag: string): SharedImage | undefined {
  const match = /^<img(?=[\s/>])([\s\S]*?)\/?\s*>$/i.exec(tag);
  if (!match) return undefined;
  const attrs = new Map<string, string>();
  const attributes = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let cursor = 0;
  while (cursor < match[1].length) {
    attributes.lastIndex = cursor;
    const attr = attributes.exec(match[1]);
    if (!attr) { if (match[1].slice(cursor).trim()) return undefined; break; }
    const name = attr[1].toLowerCase();
    const value = (attr[2] ?? attr[3] ?? attr[4] ?? "").replace(/&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, entity => parser.utils.unescapeAll(entity));
    if (!attrs.has(name)) attrs.set(name, value);
    cursor = attributes.lastIndex;
  }
  const link = attrs.get("src")?.trim();
  if (!link) return undefined;
  const dimension = (key: string) => { const value = attrs.get(key) ?? ""; return /^[1-9]\d{0,3}$/.test(value) ? Number(value) : undefined; };
  return { link, alt: attrs.get("alt") ?? "", width: dimension("width"), height: dimension("height") };
}

/** Inspect only the shared string, never the source file's full metadata cache. */
export function prepareShareMarkdown(source: string) {
  const edits: Edit[] = [];
  const lines = source.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length + 1);
  const env = {};
  const protectedRanges = parser.parse(source, env).filter(token => ["fence", "code_block", "html_block"].includes(token.type) && token.map).map(token => {
    const start = offsets[token.map![0]];
    const end = Math.min(source.length, offsets[token.map![1]]);
    const raw = source.slice(start, end);
    const images: Edit[] = [];
    let cursor = 0;
    if (token.type === "html_block") {
      // Only image-only blocks qualify. Script bodies, comments and other HTML stay literal.
      for (const tag of raw.matchAll(/<img(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
        const image = htmlImage(tag[0]);
        if (raw.slice(cursor, tag.index).trim() || !image) break;
        images.push({ start: start + tag.index, end: start + tag.index + tag[0].length, image, block: true });
        cursor = tag.index + tag[0].length;
      }
    }
    if (images.length && !raw.slice(cursor).trim()) edits.push(...images);
    else edits.push({ start, end, html: token.type === "html_block" ? `<p>${escapeHtml(raw)}</p>` : staticMarkdown.render(raw), block: true });
    return { start, end };
  });
  const scan = (text: string, base: number) => {
    const inline = new MarkdownIt({ html: true });
    const imageRule = inline.inline.ruler.__rules__.find(rule => rule.name === "image")!.fn;
    const htmlRule = inline.inline.ruler.__rules__.find(rule => rule.name === "html_inline")!.fn;
    const backticks = inline.inline.ruler.__rules__.find(rule => rule.name === "backticks")!.fn;
    inline.inline.ruler.at("backticks", (state, silent) => {
      const start = state.pos;
      const before = state.tokens.length;
      const matched = backticks(state, silent);
      if (matched && !silent && state.src === text && state.tokens.slice(before).some(token => token.type === "code_inline")) {
        edits.push({ start: base + start, end: base + state.pos, html: staticMarkdown.renderInline(text.slice(start, state.pos)) });
      }
      return matched;
    });
    // Capture parser positions rather than matching image-like strings in code spans.
    inline.inline.ruler.at("image", (state, silent) => {
      const start = state.pos;
      const before = state.tokens.length;
      const matched = imageRule(state, silent);
      if (matched && !silent && state.src === text) {
        const token = state.tokens[before];
        const src = String(token?.attrGet("src") ?? "");
        let link: string;
        try { link = decodeURIComponent(src.split("#")[0]); } catch { link = src.split("#")[0]; }
        const alt = token?.content ?? "";
        const size = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(alt);
        edits.push({ start: base + start, end: base + state.pos, image: { link, alt, ...(size ? { width: +size[1], ...(size[2] ? { height: +size[2] } : {}) } : {}) } });
      }
      return matched;
    });
    inline.inline.ruler.before("image", "wiki_embed", (state, silent) => {
      if (!state.src.startsWith("![[", state.pos)) return false;
      const end = state.src.indexOf("]]", state.pos + 3);
      if (end < 0 || state.src.slice(state.pos, end).includes("\n")) return false;
      if (!silent && state.src === text) {
        const original = state.src.slice(state.pos, end + 2);
        const [target, label = ""] = original.slice(3, -2).split("|");
        const link = target.split("#")[0];
        const size = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(label);
        edits.push({ start: base + state.pos, end: base + end + 2, ...(imageMime(link) ? { image: { link, alt: size ? link : label || link, ...(size ? { width: +size[1], ...(size[2] ? { height: +size[2] } : {}) } : {}) } } : { html: `<code>${escapeHtml(original)}</code>` }) });
      }
      if (!silent) { const token = state.push("text", "", 0); token.content = state.src.slice(state.pos, end + 2); }
      state.pos = end + 2;
      return true;
    });
    inline.inline.ruler.at("html_inline", (state, silent) => {
      const start = state.pos;
      const matched = htmlRule(state, silent);
      if (matched && !silent && state.src === text) {
        const tag = text.slice(start, state.pos);
        const image = htmlImage(tag);
        edits.push({ start: base + start, end: base + state.pos, ...(image ? { image } : { html: escapeHtml(tag) }) });
      }
      return matched;
    });
    inline.parseInline(text, env);
  };
  let cursor = 0;
  for (const range of protectedRanges) { scan(source.slice(cursor, range.start), cursor); cursor = range.end; }
  scan(source.slice(cursor), cursor);
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const slots: { marker: string; html?: string; image?: SharedImage }[] = [];
  const prefix = `AGENTNOTE${randomUUID().replace(/-/g, "")}SLOT`;
  let markdown = "";
  cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    const marker = `${prefix}${slots.length}END`;
    slots.push({ marker, html: edit.html, image: edit.image });
    markdown += source.slice(cursor, edit.start) + (edit.block ? `\n\n${marker}\n\n` : marker);
    cursor = edit.end;
  }
  markdown += source.slice(cursor);
  return { markdown, slots };
}

/** Images use same-origin URLs; no app:// URLs or external requests leave the host. */
export function restoreShareSlots(html: string, prepared: ReturnType<typeof prepareShareMarkdown>, shareId: string, imageSources?: ReadonlyMap<string, string>): string {
  for (const slot of prepared.slots) {
    let replacement = slot.html ?? "";
    if (slot.image) {
      const { link, alt, width, height } = slot.image;
      const local = imageMime(link) && !/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(link) && !link.includes("\0");
      const embedded = !imageSources && /^data:/i.test(link) ? readInlineImage(link) : null;
      const src = imageSources ? imageSources.get(link) : embedded ? `data:${embedded.mime};base64,${embedded.bytes.toString("base64")}` : local ? `/api/shares/${encodeURIComponent(shareId)}/image?link=${encodeURIComponent(link)}` : undefined;
      replacement = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}>` : `<span class="unavailable-embed">${escapeHtml(alt || (/^data:/i.test(link) ? t("内嵌图片无法显示") : link))}</span>`;
    }
    // Block slots must not leave <pre> or <p> nested inside a paragraph.
    html = html.split(`<p>${slot.marker}</p>`).join(replacement).split(slot.marker).join(replacement);
  }
  return html;
}
