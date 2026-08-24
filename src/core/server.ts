import * as http from "http";
import { CreateNodeInput, StoreError, UpdateNodeInput, VaultStore } from "./store";
import { NodeType, qualityWarnings } from "./types";

export interface ServerOptions { port: number; host?: string }
const nodeView = (node: Awaited<ReturnType<VaultStore["getNode"]>>) => ({ ...node, warnings: qualityWarnings(node) });

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new StoreError(400, "请求体必须是合法 JSON"); }
}

export class AgentServer {
  private server: http.Server | null = null;
  constructor(readonly store: VaultStore, private opts: ServerOptions) {}
  get port(): number | null { const address = this.server?.address(); return address && typeof address === "object" ? address.port : null; }
  async start(): Promise<number> {
    await this.store.init();
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((error) => send(res, error instanceof StoreError ? error.statusCode : 500, { ok: false, error: error instanceof Error ? error.message : String(error) })));
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", resolve); });
    return this.port!;
  }
  async stop(): Promise<void> { if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = null; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (url.pathname === "/api/health" && method === "GET") return send(res, 200, { ok: true, data: { status: "up", version: 2, vault: this.store.root } });
    if (parts[0] !== "api") return send(res, 404, { ok: false, error: "接口不存在" });

    if (parts[1] === "nodes" && parts.length === 2) {
      if (method === "GET") return send(res, 200, { ok: true, data: (await this.store.listNodes({ q: url.searchParams.get("q") ?? undefined, type: url.searchParams.get("type") as NodeType ?? undefined, archived: url.searchParams.has("archived") ? url.searchParams.get("archived") === "true" : undefined })).map(nodeView) });
      if (method === "POST") return send(res, 201, { ok: true, data: nodeView(await this.store.createNode(await readBody(req) as CreateNodeInput)) });
    }
    if (parts[1] === "nodes" && parts.length === 3) {
      const id = parts[2];
      if (method === "GET") return send(res, 200, { ok: true, data: nodeView(await this.store.getNode(id)) });
      if (method === "PUT" || method === "PATCH") return send(res, 200, { ok: true, data: nodeView(await this.store.updateNode(id, await readBody(req) as UpdateNodeInput)) });
    }
    if (parts[1] === "nodes" && parts.length === 4 && parts[3] === "archive" && method === "POST") {
      const body = await readBody(req) as { archived?: boolean };
      return send(res, 200, { ok: true, data: nodeView(await this.store.archiveNode(parts[2], body.archived !== false)) });
    }
    if (parts[1] === "shares" && parts.length === 2 && method === "POST") {
      const body = await readBody(req) as { nodeId?: string; path?: string; background?: string; selection?: string };
      if (body.nodeId) return send(res, 201, { ok: true, data: await this.store.createShare(body.nodeId, body.selection) });
      if (body.path) return send(res, 201, { ok: true, data: await this.store.createPathShare(body.path, body.background, body.selection) });
      throw new StoreError(400, "nodeId 或 path 至少提供一个");
    }
    if (parts[1] === "shares" && parts.length === 4 && parts[3] === "resolve" && method === "GET") {
      const data = await this.store.resolveShare(parts[2]);
      if (url.searchParams.get("raw") === "1") {
        const text = data.kind === "folder" ? data.entries.join("\n") : data.content;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
        return void res.end(text);
      }
      return send(res, 200, { ok: true, data });
    }
    return send(res, 404, { ok: false, error: `没有这条路由: ${method} ${url.pathname}` });
  }
}
function send(res: http.ServerResponse, status: number, payload: unknown): void { const body = JSON.stringify(payload, null, 2); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); res.end(body); }
