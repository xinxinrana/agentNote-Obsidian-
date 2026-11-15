import agentNoteLogo from "../../assets/brand/xiaoji-mark.svg";
import obsidianLogo from "../../assets/brand/obsidian.png";
import { t } from "../i18n";
import { escapeHtml } from "./shareMarkdown";

/** Embedded assets keep exported files self-contained and free of remote requests. */
export function shareBrand(): string {
  return `<div class="share-brand"><span>${t("分享自")}</span><a href="https://obsidian.md/"><img src="${escapeHtml(obsidianLogo)}" alt="" width="20" height="20">Obsidian</a><span aria-hidden="true">·</span><a href="https://github.com/xinxinrana/agentNote-Obsidian-/"><img src="${escapeHtml(agentNoteLogo)}" alt="" width="24" height="24">agentNote</a></div>`;
}

export const shareBrandStyles = `.share-brand{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--muted)}.share-brand a{display:inline-flex;align-items:center;gap:5px;color:inherit;text-decoration:none;margin:0}.share-brand img{display:block;flex:none;object-fit:contain;margin:0}`;
