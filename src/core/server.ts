/**
 * AgentServer — the agent-facing local HTTP API (FR-3, 原则 5: agent 是第一公民).
 *
 * Plain Node `http`, bound to 127.0.0.1 only (纯本地, 数据不出本机).
 * No Obsidian imports: the same server runs inside the plugin and inside
 * the black-box e2e tests.
 */

import * as http from "http";
import { VaultStore, StoreError, CreateNodeInput, UpdateNodeInput } from "./store";
import { AgentNode, NodeType, qualityWarnings } from "./types";

export interface ServerOptions {
  port: number;
  host?: string; // defaults to 127.0.0.1
}

function nodeView(node: AgentNode) {
  return { ...node, warnings: qualityWarnings(node) };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoreError(400, "请求体必须是合法 JSON");
  }
}

export class AgentServer {
  private server: http.Server | null = null;
  readonly store: VaultStore;
  private opts: ServerOptions;

  constructor(store: VaultStore, opts: ServerOptions) {
    this.store = store;
    this.opts = opts;
  }

  get port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  async start(): Promise<number> {
    await this.store.init();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        const status = e instanceof StoreError ? e.statusCode : 500;
        const message = e instanceof Error ? e.message : String(e);
        send(res, status, { ok: false, error: message });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => resolve());
    });
    return this.port!;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segs = url.pathname.split("/").filter(Boolean); // e.g. ["api","nodes","n-x","versions","2"]
    const method = req.method ?? "GET";
    const store = this.store;

    if (url.pathname === "/api/health" && method === "GET") {
      send(res, 200, { ok: true, data: { status: "up", vault: store.root } });
      return;
    }

    if (segs[0] !== "api") {
      send(res, 404, { ok: false, error: "接口不存在" });
      return;
    }

    // /api/nodes
    if (segs[1] === "nodes" && segs.length === 2) {
      if (method === "GET") {
        const nodes = await store.listNodes({
          tag: url.searchParams.get("tag") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          type: (url.searchParams.get("type") as NodeType) ?? undefined,
        });
        send(res, 200, { ok: true, data: nodes.map(nodeView) });
        return;
      }
      if (method === "POST") {
        const body = (await readBody(req)) as CreateNodeInput;
        const node = await store.createNode(body);
        send(res, 201, { ok: true, data: nodeView(node) });
        return;
      }
    }

    // /api/nodes/:id[/...]
    if (segs[1] === "nodes" && segs.length >= 3) {
      const id = segs[2];
      if (segs.length === 3) {
        if (method === "GET") {
          send(res, 200, { ok: true, data: nodeView(await store.getNode(id)) });
          return;
        }
        if (method === "PUT" || method === "PATCH") {
          const body = (await readBody(req)) as UpdateNodeInput;
          send(res, 200, { ok: true, data: nodeView(await store.updateNode(id, body)) });
          return;
        }
      }
      if (segs[3] === "groups" && (method === "PUT" || method === "POST")) {
        const body = (await readBody(req)) as { groupIds: string[] };
        if (!Array.isArray(body.groupIds)) throw new StoreError(400, "groupIds 必须是数组");
        await store.setNodeGroups(id, body.groupIds);
        send(res, 200, { ok: true, data: await store.listGroups() });
        return;
      }
      if (segs[3] === "snapshots") {
        if (method === "GET") {
          send(res, 200, { ok: true, data: await store.listSnapshots(id) });
          return;
        }
        if (method === "POST") {
          const body = (await readBody(req)) as { note?: string };
          send(res, 201, { ok: true, data: await store.createSnapshot(id, body.note) });
          return;
        }
      }
    }

    // /api/groups
    if (segs[1] === "groups") {
      if (segs.length === 2) {
        if (method === "GET") {
          send(res, 200, { ok: true, data: await store.listGroups() });
          return;
        }
        if (method === "POST") {
          const body = (await readBody(req)) as { name: string; parentId?: string | null };
          send(res, 201, { ok: true, data: await store.createGroup(body.name, body.parentId ?? null) });
          return;
        }
      }
      if (segs.length === 3 && method === "DELETE") {
        await store.deleteGroup(segs[2]);
        send(res, 200, { ok: true, data: null });
        return;
      }
    }

    // /api/shares
    if (segs[1] === "shares") {
      if (segs.length === 2) {
        if (method === "GET") {
          send(res, 200, { ok: true, data: await store.listShares() });
          return;
        }
        if (method === "POST") {
          const body = (await readBody(req)) as {
            nodeId?: string;
            path?: string;
            selection?: string;
          };
          // Either an agentNote node, or ANY vault file/folder by path.
          if (body.nodeId) {
            send(res, 201, { ok: true, data: await store.createShare(body.nodeId, body.selection) });
            return;
          }
          if (body.path) {
            send(res, 201, { ok: true, data: await store.createPathShare(body.path, body.selection) });
            return;
          }
          throw new StoreError(400, "nodeId 或 path 至少提供一个");
        }
      }
      if (segs.length === 4 && segs[3] === "revoke" && method === "POST") {
        send(res, 200, { ok: true, data: await store.revokeShare(segs[2]) });
        return;
      }
      if (segs.length === 4 && segs[3] === "resolve" && method === "GET") {
        const result = await store.resolveShare(segs[2]);
        // ?raw=1 → plain text body, for agents/tools that just want the content
        if (url.searchParams.get("raw") === "1") {
          const body = result.content;
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        send(res, 200, { ok: true, data: result });
        return;
      }
    }

    send(res, 404, { ok: false, error: `没有这条路由: ${method} ${url.pathname}` });
  }
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
