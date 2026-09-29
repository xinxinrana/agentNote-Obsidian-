import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { InsightEvent } from "./store";

export interface ActivityLogOptions {
  /** Kept outside the vault so cloning a vault does not clone its writer identity. */
  deviceIdFile?: string;
}

const writerQueues = new Map<string, Promise<void>>();
const devicePattern = /^[a-zA-Z0-9-]{1,80}$/;
export function isLocalActivityBurst(events: readonly { type: string; at: number }[]): boolean {
  for (let end = 0, start = 0; end < events.length; end++) {
    while (events[end].at - events[start].at >= 1_000) start++;
    if (end - start + 1 > 10) return true;
    let same = 0;
    for (let index = start; index <= end; index++) if (events[index].type === events[end].type) same++;
    if (same > 3) return true;
  }
  return false;
}
function isEvent(value: unknown): value is InsightEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as InsightEvent;
  return typeof event.at === "string" && typeof event.type === "string"
    && (event.eventId === undefined || (typeof event.eventId === "string" && !!event.eventId))
    && (event.deviceId === undefined || (typeof event.deviceId === "string" && devicePattern.test(event.deviceId)));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Each machine writes only its own array; other machines and legacy history are read-only. */
export class ActivityLog {
  private identity: Promise<string> | null = null;
  private readonly deviceIdFile: string;
  constructor(private directory: string, options: ActivityLogOptions = {}) {
    this.deviceIdFile = options.deviceIdFile ?? path.join(os.homedir(), ".agentnote", "device-id");
  }
  private async loadDeviceId(): Promise<string> {
    await fsp.mkdir(path.dirname(this.deviceIdFile), { recursive: true });
    try { await fsp.access(this.deviceIdFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${this.deviceIdFile}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, randomUUID(), { flag: "wx", mode: 0o600 });
        // Publish a complete identity without overwriting a concurrently created one.
        try { await fsp.link(temporary, this.deviceIdFile); }
        catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
      } finally { await fsp.rm(temporary, { force: true }); }
    }
    const id = (await fsp.readFile(this.deviceIdFile, "utf8")).trim();
    if (!devicePattern.test(id)) throw new Error("agentNote 本机设备 ID 无效，请检查本机 device-id 文件。");
    return id;
  }
  private deviceId(): Promise<string> {
    if (!this.identity) this.identity = this.loadDeviceId().catch((error) => { this.identity = null; throw error; });
    return this.identity;
  }
  async init(): Promise<void> { await this.deviceId(); }
  async filePath(): Promise<string> { return path.join(this.directory, `events.${await this.deviceId()}.json`); }
  private async readFile(file: string): Promise<InsightEvent[]> {
    let raw: string;
    try { raw = await fsp.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; }
    catch { throw new Error(`活动日志不是合法 JSON：${path.basename(file)}`); }
    if (!Array.isArray(value) || !value.every(isEvent)) throw new Error(`活动日志格式无效：${path.basename(file)}`);
    return value;
  }
  async read(): Promise<InsightEvent[]> {
    const files = (await fsp.readdir(this.directory)).filter((name) => name === "events.json" || /^events\.[a-zA-Z0-9-]+\.json$/.test(name)).sort();
    const seen = new Set<string>();
    const result: InsightEvent[] = [];
    for (const file of files) {
      const occurrences = new Map<string, number>();
      for (const event of await this.readFile(path.join(this.directory, file))) {
        // Old history stays untouched. Stable IDs distinguish even identical repeated legacy operations.
        let eventId = event.eventId;
        if (!eventId) {
          const hash = createHash("sha256").update(canonical(event)).digest("hex");
          const occurrence = occurrences.get(hash) ?? 0;
          occurrences.set(hash, occurrence + 1);
          eventId = `legacy-${hash}-${occurrence}`;
        }
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        result.push({ ...event, eventId });
      }
    }
    return result.sort((a, b) => a.at.localeCompare(b.at) || a.eventId!.localeCompare(b.eventId!));
  }
  async backupPastDays(now = new Date()): Promise<{ created: number; existing: number }> {
    const dayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const today = dayKey(now);
    const deviceId = await this.deviceId();
    const sources = [{ file: "events.json", label: `legacy.${deviceId}` }, { file: `events.${deviceId}.json`, label: deviceId }];
    const snapshots: { day: string; name: string; events: InsightEvent[] }[] = [];
    for (const source of sources) {
      const days = new Map<string, InsightEvent[]>();
      for (const event of await this.readFile(path.join(this.directory, source.file))) {
        const date = new Date(event.at);
        if (Number.isNaN(date.getTime())) throw new Error(`活动日志时间无效：${source.file}`);
        const day = dayKey(date);
        if (day >= today) continue;
        const events = days.get(day) ?? [];
        events.push(event);
        days.set(day, events);
      }
      for (const [day, events] of days) snapshots.push({ day, name: `events.${source.label}.${day}.json`, events });
    }
    snapshots.sort((left, right) => left.day.localeCompare(right.day) || left.name.localeCompare(right.name));
    const directory = path.join(this.directory, "cold-backups");
    let created = 0;
    let existing = 0;
    if (snapshots.length) await fsp.mkdir(directory, { recursive: true });
    for (const snapshot of snapshots) {
      const target = path.join(directory, snapshot.name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(snapshot.events, null, 2), { flag: "wx" });
        try { await fsp.link(temporary, target); created++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") existing++; else throw error; }
      } finally { await fsp.rm(temporary, { force: true }); }
    }
    return { created, existing };
  }
  async append(event: Omit<InsightEvent, "at" | "eventId" | "deviceId">): Promise<void> {
    const deviceId = await this.deviceId();
    const file = await this.filePath();
    const task = (writerQueues.get(file) ?? Promise.resolve()).then(async () => {
      const events = await this.readFile(file);
      events.push({ ...event, at: new Date().toISOString(), eventId: randomUUID(), deviceId });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(events, null, 2), "utf8");
        await fsp.rename(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }); }
    });
    writerQueues.set(file, task.catch(() => undefined));
    await task;
  }
}
