import { t } from "../i18n";
import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { constants } from "fs";
import { parse } from "yaml";
import xiaojiMarkUrl from "../../assets/brand/xiaoji-mark.svg";
import skillIconIcoUrl from "../../assets/brand/skill-icon.ico";
import skillIconPngUrl from "../../assets/brand/skill-icon.png";

export interface AgentConnection { name: string; skillPath: string; connectedAt: string; icon?: string }

function dataUrlBytes(url: string): Buffer {
  const comma = url.indexOf(",");
  return url.slice(0, comma).includes(";base64") ? Buffer.from(url.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(url.slice(comma + 1)), "binary");
}
const productSvg = decodeURIComponent(xiaojiMarkUrl.slice(xiaojiMarkUrl.indexOf(",") + 1));
const productIcon = `data:image/svg+xml;base64,${Buffer.from(productSvg).toString("base64")}`;
/** Every encoding the plugin itself serves for its product mark. */
const PRODUCT_ICONS = new Set([productIcon, `data:image/x-icon;base64,${dataUrlBytes(skillIconIcoUrl).toString("base64")}`, `data:image/png;base64,${dataUrlBytes(skillIconPngUrl).toString("base64")}`]);
const PRODUCT_ICO_BYTES = dataUrlBytes(skillIconIcoUrl);
const PRODUCT_PNG_BYTES = dataUrlBytes(skillIconPngUrl);
/** Reformatting or re-encoding the product SVG keeps its path data, so compare on that. */
function svgMark(text: string): string {
  const paths = [...text.matchAll(/\sd\s*=\s*"([^"]*)"/g)].map((match) => match[1].replace(/\s+/g, " ").trim()).sort();
  return paths.length ? createHash("sha256").update(paths.join("\u0000")).digest("hex") : "";
}
const PRODUCT_MARK = svgMark(productSvg);
const PRODUCT_ICON_FILENAME = /^(skill[-_ ]?icon|agentnote)([-_. ].*)?\.(svg|png|ico)$/i;

function isProductIcon(icon?: string): boolean {
  if (!icon) return false;
  if (PRODUCT_ICONS.has(icon)) return true;
  const comma = icon.indexOf(",");
  if (!icon.startsWith("data:image/") || comma === -1) return false;
  const bytes = icon.slice(0, comma).includes(";base64") ? Buffer.from(icon.slice(comma + 1), "base64") : Buffer.from(decodeURIComponent(icon.slice(comma + 1)), "binary");
  if (icon.startsWith("data:image/svg+xml")) { const mark = svgMark(bytes.toString("utf8")); return !!mark && mark === PRODUCT_MARK; }
  return bytes.equals(PRODUCT_ICO_BYTES) || bytes.equals(PRODUCT_PNG_BYTES);
}
function withoutProductIcon(connection: AgentConnection): AgentConnection {
  return isProductIcon(connection.icon) ? { ...connection, icon: undefined } : connection;
}

function isAgentConnection(value: unknown): value is AgentConnection {
  return !!value && typeof value === "object"
    && "name" in value && typeof value.name === "string"
    && "skillPath" in value && typeof value.skillPath === "string"
    && "connectedAt" in value && typeof value.connectedAt === "string"
    && (!("icon" in value) || typeof value.icon === "string");
}

const ADDITION_HEADER = /\n\n<!-- agentNote:additional -->\n## (?:附加要求|Additional instructions)\n\n/g;

export function splitSkillInstructions(content: string): { base: string; additional: string } {
  const matches = [...content.matchAll(ADDITION_HEADER)];
  const last = matches.at(-1);
  return last ? { base: content.slice(0, last.index), additional: content.slice(last.index + last[0].length).trim() } : { base: content, additional: "" };
}

export function withSkillInstructions(base: string, additional: string): string {
  return `${base.trimEnd()}${additional.trim() ? `\n\n<!-- agentNote:additional -->\n## ${t("附加要求")}\n\n${additional.trim()}` : ""}\n`;
}

export function agentNameKey(name: string): string { return name.trim().toLowerCase(); }

/** Agent 接入是本机事实（Skill 装在用户目录下），因此记录按电脑全局存放一份。 */
export function connectionsFile(home: string): string {
  return path.join(home, ".agentnote", "connections.json");
}

const LEGACY_CONNECTIONS = /^connections\.[^.].*\.json$/;

function validSkill(content: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) return false;
  try {
    const metadata: unknown = parse(frontmatter[1]);
    return !!metadata && typeof metadata === "object" && "name" in metadata && metadata.name === "agentnote"
      && "description" in metadata && typeof metadata.description === "string" && !!metadata.description.trim();
  } catch { return false; }
}

export class AgentConnections {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}

  private queued<T>(action: () => Promise<T>): Promise<T> {
    const result = this.writes.then(action);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async list(): Promise<AgentConnection[]> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.migrateLegacy();
    }
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(isAgentConnection)) throw new Error(t("本机 Agent 接入记录格式无效"));
    return value.map(withoutProductIcon);
  }

  /** 旧版本按 vault 路径分文件存放；升级后合并成一份，技能文件已不在的记录直接丢弃。 */
  private async migrateLegacy(): Promise<AgentConnection[]> {
    const directory = path.dirname(this.file);
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch { return []; }
    const latest = new Map<string, AgentConnection>();
    for (const name of names) {
      if (!LEGACY_CONNECTIONS.test(name)) continue;
      let value: unknown;
      try { value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); }
      catch { continue; }
      if (!Array.isArray(value)) continue;
      for (const connection of value) {
        if (!isAgentConnection(connection)) continue;
        const key = agentNameKey(connection.name);
        const previous = latest.get(key);
        if (!previous || previous.connectedAt < connection.connectedAt) latest.set(key, connection);
      }
    }
    const connections: AgentConnection[] = [];
    for (const connection of latest.values()) {
      try { if ((await fs.stat(connection.skillPath)).isFile()) connections.push(connection); }
      catch { /* 技能文件已不存在，视为未接入 */ }
    }
    connections.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
    if (connections.length) { try { await this.save(connections); } catch { /* 迁移写入失败时仍返回记录 */ } }
    return connections.map(withoutProductIcon);
  }

  private async save(connections: AgentConnection[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(connections, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.file); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  async register(name: string, reportedPath: string, reportedIconPath?: string): Promise<AgentConnection> {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80 || !path.isAbsolute(reportedPath) || path.basename(reportedPath) !== "SKILL.md") throw new Error(t("请上报 Agent 名称和 SKILL.md 的绝对路径"));
    const skillPath = await fs.realpath(reportedPath);
    if (path.basename(skillPath) !== "SKILL.md") throw new Error(t("路径必须指向 SKILL.md"));
    const stat = await fs.stat(skillPath);
    if (!stat.isFile() || stat.size > 1_000_000 || !validSkill(await fs.readFile(skillPath, "utf8"))) throw new Error(t("该文件不是有效的 agentnote SKILL.md"));
    const identityPath = path.join(path.dirname(skillPath), "agentnote.identity.json");
    const identity: unknown = JSON.parse(await fs.readFile(identityPath, "utf8"));
    if (!identity || typeof identity !== "object" || !("id" in identity) || typeof identity.id !== "string" || !identity.id.trim()
      || !("name" in identity) || typeof identity.name !== "string" || agentNameKey(identity.name) !== agentNameKey(cleanName)) throw new Error(t("身份文件中的名称必须与上报的 Agent 名称一致"));
    let icon: string | undefined;
    if (reportedIconPath !== undefined) {
      if (!path.isAbsolute(reportedIconPath)) throw new Error(t("图标必须是 Skill 目录中的图片文件"));
      const iconPath = await fs.realpath(reportedIconPath);
      if (path.dirname(iconPath) !== path.dirname(skillPath)) throw new Error(t("图标必须是 Skill 目录中的图片文件"));
      const mime = { ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" }[path.extname(iconPath).toLowerCase()];
      const iconStat = await fs.stat(iconPath);
      if (!mime || !iconStat.isFile() || !iconStat.size || iconStat.size > 128_000) throw new Error(t("图标需要是小于 128 KB 的 PNG、ICO 或 SVG 文件"));
      const bytes = await fs.readFile(iconPath);
      const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : mime === "image/x-icon" ? bytes.subarray(0, 4).equals(Buffer.from("00000100", "hex"))
          : /<svg[\s>]/i.test(bytes.toString("utf8").slice(0, 1024));
      if (!valid) throw new Error(t("图标需要是小于 128 KB 的 PNG、ICO 或 SVG 文件"));
      const candidate = `data:${mime};base64,${bytes.toString("base64")}`;
      if (PRODUCT_ICON_FILENAME.test(path.basename(iconPath)) || isProductIcon(candidate)) throw new Error(t("这是 agentNote 自己的产品图标，请改用该 Agent 的官方图标；无法确认时省略 iconPath"));
      icon = candidate;
    }
    return this.queued(async () => {
      const connections = await this.list();
      const previous = connections.findIndex((item) => agentNameKey(item.name) === agentNameKey(cleanName));
      const connection = { name: cleanName, skillPath, connectedAt: new Date().toISOString(), icon: icon ?? (previous === -1 ? undefined : connections[previous].icon) };
      if (previous === -1) connections.push(connection); else connections[previous] = connection;
      await this.save(connections);
      return connection;
    });
  }

  async remove(name: string): Promise<void> {
    await this.queued(async () => {
      const connections = await this.list();
      const connection = connections.find((item) => agentNameKey(item.name) === agentNameKey(name));
      if (!connection) return;
      let backup: string | null = null;
      try {
        await this.readSkill(connection);
        backup = `${connection.skillPath}.agentnote-backup-${randomUUID()}`;
        await fs.rename(connection.skillPath, backup);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await this.save(connections.filter((item) => item !== connection)); }
      catch (error) { if (backup) await fs.rename(backup, connection.skillPath); throw error; }
    });
  }

  async readSkill(connection: AgentConnection): Promise<string> {
    if (await fs.realpath(connection.skillPath) !== connection.skillPath) throw new Error(t("Skill 路径已改变，请重新接入"));
    const content = await fs.readFile(connection.skillPath, "utf8");
    if (!validSkill(content)) throw new Error(t("当前文件不是有效的 agentnote SKILL.md"));
    return content;
  }

  async saveSkill(connection: AgentConnection, expected: string, updated: string): Promise<void> {
    if (!validSkill(updated)) throw new Error(t("技能说明需要包含 agentnote 的 name 和 description 元信息"));
    const current = await this.readSkill(connection);
    if (current !== expected) throw new Error(t("技能文件已被其他程序修改，请重新打开后再编辑"));
    const backup = `${connection.skillPath}.agentnote-backup-${randomUUID()}`;
    await fs.copyFile(connection.skillPath, backup, constants.COPYFILE_EXCL);
    const temporary = `${connection.skillPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, updated, { encoding: "utf8", mode: (await fs.stat(connection.skillPath)).mode, flag: "wx" }); await fs.rename(temporary, connection.skillPath); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
