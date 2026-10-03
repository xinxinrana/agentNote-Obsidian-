import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { constants } from "fs";
import { parse } from "yaml";

export interface AgentConnection { name: string; skillPath: string; connectedAt: string }

const ADDITION_HEADER = "\n\n<!-- agentNote:additional -->\n## 附加要求\n\n";

export function splitSkillInstructions(content: string): { base: string; additional: string } {
  const at = content.lastIndexOf(ADDITION_HEADER);
  return at === -1 ? { base: content, additional: "" } : { base: content.slice(0, at), additional: content.slice(at + ADDITION_HEADER.length).trim() };
}

export function withSkillInstructions(base: string, additional: string): string {
  return `${base.trimEnd()}${additional.trim() ? `${ADDITION_HEADER}${additional.trim()}` : ""}\n`;
}

export function agentNameKey(name: string): string { return name.trim().toLowerCase(); }

export function localConnectionsFile(home: string, vaultRoot: string): string {
  const vaultId = createHash("sha256").update(path.resolve(vaultRoot)).digest("hex").slice(0, 16);
  return path.join(home, ".agentnote", `connections.${vaultId}.json`);
}

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
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object" && typeof item.name === "string" && typeof item.skillPath === "string" && typeof item.connectedAt === "string")) throw new Error("本机 Agent 接入记录格式无效");
    return value as AgentConnection[];
  }

  private async save(connections: AgentConnection[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(connections, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temporary, this.file); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  async register(name: string, reportedPath: string): Promise<AgentConnection> {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80 || !path.isAbsolute(reportedPath) || path.basename(reportedPath) !== "SKILL.md") throw new Error("请上报 Agent 名称和 SKILL.md 的绝对路径");
    const skillPath = await fs.realpath(reportedPath);
    if (path.basename(skillPath) !== "SKILL.md") throw new Error("路径必须指向 SKILL.md");
    const stat = await fs.stat(skillPath);
    if (!stat.isFile() || stat.size > 1_000_000 || !validSkill(await fs.readFile(skillPath, "utf8"))) throw new Error("该文件不是有效的 agentnote SKILL.md");
    const identityPath = path.join(path.dirname(skillPath), "agentnote.identity.json");
    const identity: unknown = JSON.parse(await fs.readFile(identityPath, "utf8"));
    if (!identity || typeof identity !== "object" || !("id" in identity) || typeof identity.id !== "string" || !identity.id.trim()
      || !("name" in identity) || typeof identity.name !== "string" || agentNameKey(identity.name) !== agentNameKey(cleanName)) throw new Error("身份文件中的名称必须与上报的 Agent 名称一致");
    return this.queued(async () => {
      const connections = await this.list();
      const previous = connections.findIndex((item) => agentNameKey(item.name) === agentNameKey(cleanName));
      const connection = { name: cleanName, skillPath, connectedAt: new Date().toISOString() };
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
    if (await fs.realpath(connection.skillPath) !== connection.skillPath) throw new Error("Skill 路径已改变，请重新接入");
    const content = await fs.readFile(connection.skillPath, "utf8");
    if (!validSkill(content)) throw new Error("当前文件不是有效的 agentnote SKILL.md");
    return content;
  }

  async saveSkill(connection: AgentConnection, expected: string, updated: string): Promise<void> {
    if (!validSkill(updated)) throw new Error("技能说明需要包含 agentnote 的 name 和 description 元信息");
    const current = await this.readSkill(connection);
    if (current !== expected) throw new Error("技能文件已被其他程序修改，请重新打开后再编辑");
    const backup = `${connection.skillPath}.agentnote-backup-${randomUUID()}`;
    await fs.copyFile(connection.skillPath, backup, constants.COPYFILE_EXCL);
    const temporary = `${connection.skillPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, updated, { encoding: "utf8", mode: (await fs.stat(connection.skillPath)).mode, flag: "wx" }); await fs.rename(temporary, connection.skillPath); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
