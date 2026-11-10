import MarkdownIt from "markdown-it";
import { randomUUID } from "crypto";

const parser = new MarkdownIt({ html: true });
const staticMarkdown = new MarkdownIt({ html: false, linkify: false });
export const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const imageMime = (link: string): string | undefined => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" }[link.split(".").pop()?.toLowerCase() ?? ""]);
export interface SharedImage { link: string; alt: string; width?: number; height?: number }
interface Edit { start: number; end: number; block?: boolean; html?: string; image?: SharedImage }

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
    const html = token.type === "html_block" ? `<p>${escapeHtml(raw)}</p>` : staticMarkdown.render(raw);
    return { start, end, html, block: true };
  });
  edits.push(...protectedRanges);
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
      if (matched && !silent && state.src === text) edits.push({ start: base + start, end: base + state.pos, html: escapeHtml(text.slice(start, state.pos)) });
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
export function restoreShareSlots(html: string, prepared: ReturnType<typeof prepareShareMarkdown>, shareId: string): string {
  for (const slot of prepared.slots) {
    let replacement = slot.html ?? "";
    if (slot.image) {
      const { link, alt, width, height } = slot.image;
      const local = imageMime(link) && !/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(link) && !link.includes("\0");
      replacement = local ? `<img src="/api/shares/${encodeURIComponent(shareId)}/image?link=${encodeURIComponent(link)}" alt="${escapeHtml(alt)}" loading="lazy"${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}>` : `<span class="unavailable-embed">${escapeHtml(alt || link)}</span>`;
    }
    // Block slots must not leave <pre> or <p> nested inside a paragraph.
    html = html.split(`<p>${slot.marker}</p>`).join(replacement).split(slot.marker).join(replacement);
  }
  return html;
}
