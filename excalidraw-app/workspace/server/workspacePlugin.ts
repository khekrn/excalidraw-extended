/**
 * Local workspace server — a Vite plugin that serves a folder of
 * `.excalidraw` files to the app (dev server and `vite preview`).
 *
 * The folder defaults to Google Drive for Desktop's "My Drive/Excalidraw"
 * (so everything is backed up by Drive), and can be changed from the app or
 * with the EXCALIDRAW_WORKSPACE_DIR env var.
 *
 * Endpoints live under `/__workspace/` and only answer loopback requests.
 */
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import { runClaudePrompt } from "./claudeRunner";

import type { IncomingMessage, ServerResponse } from "http";
import type { Plugin, ViteDevServer, PreviewServer } from "vite";

export const WORKSPACE_API_PREFIX = "/__workspace";

const FILE_EXT = ".excalidraw";
const META_FILE = ".workspace.json";
const TRASH_DIR = ".trash";
const CONFIG_FILE = path.join(os.homedir(), ".excalidraw-workspace.json");
const MAX_BODY_BYTES = 200 * 1024 * 1024;

export type TreeNode = {
  type: "folder" | "file";
  /** display name (no extension for files) */
  name: string;
  /** POSIX path relative to the workspace root */
  path: string;
  mtime: number;
  children?: TreeNode[];
};

type WorkspaceMeta = {
  version: 1;
  icons: Record<string, string>;
  favorites: string[];
  lastOpened: string | null;
};

const EMPTY_META: WorkspaceMeta = {
  version: 1,
  icons: {},
  favorites: [],
  lastOpened: null,
};

// -----------------------------------------------------------------------------
// root folder resolution
// -----------------------------------------------------------------------------

const findGoogleDriveMyDrive = (): string | null => {
  const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
  try {
    for (const entry of fs.readdirSync(cloudStorage)) {
      if (entry.startsWith("GoogleDrive-")) {
        const myDrive = path.join(cloudStorage, entry, "My Drive");
        if (fs.existsSync(myDrive)) {
          return myDrive;
        }
      }
    }
  } catch {
    // no CloudStorage (not macOS, or Drive for Desktop not installed)
  }
  const legacy = path.join(os.homedir(), "Google Drive", "My Drive");
  return fs.existsSync(legacy) ? legacy : null;
};

const readConfig = (): { root?: string } => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
};

const resolveInitialRoot = () => {
  if (process.env.EXCALIDRAW_WORKSPACE_DIR) {
    return path.resolve(process.env.EXCALIDRAW_WORKSPACE_DIR);
  }
  const configured = readConfig().root;
  if (configured) {
    return configured;
  }
  const myDrive = findGoogleDriveMyDrive();
  return myDrive
    ? path.join(myDrive, "Excalidraw")
    : path.join(os.homedir(), "Excalidraw Workspace");
};

const describeRoot = (root: string) => {
  const match = root.match(/GoogleDrive-[^/]+\/(.*)$/);
  if (match) {
    return { label: `Google Drive · ${match[1]}`, isGoogleDrive: true };
  }
  const home = os.homedir();
  return {
    label: root.startsWith(home) ? `~${root.slice(home.length)}` : root,
    isGoogleDrive: false,
  };
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const sha1 = (data: string | Buffer) =>
  crypto.createHash("sha1").update(data).digest("hex");

const toPosix = (p: string) => p.split(path.sep).join("/");

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const isValidName = (name: string) =>
  !!name &&
  name.trim() === name &&
  !name.startsWith(".") &&
  !/[/\\:*?"<>|]/.test(name) &&
  ![...name].some((char) => char.charCodeAt(0) < 32) &&
  name.length <= 200;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const readJSONBody = async <T>(req: IncomingMessage): Promise<T> => {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
};

const sendJSON = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
};

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const hostnameOf = (hostHeader: string | undefined) => {
  if (!hostHeader) {
    return "";
  }
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return "";
  }
};

/**
 * Blocks other machines, DNS-rebinding and cross-site requests: the files on
 * disk (and the local `claude` CLI) are reachable only from this computer's
 * own browser tab.
 */
const assertLocalRequest = (req: IncomingMessage) => {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress || "")) {
    throw new HttpError(403, "Workspace API is only available on localhost");
  }
  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    throw new HttpError(403, "Unexpected Host header");
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      // invalid origin
    }
    if (!LOOPBACK_HOSTNAMES.has(originHost)) {
      throw new HttpError(403, "Cross-origin request rejected");
    }
  }
  // custom header → cross-site pages can't send it without a CORS preflight,
  // which we never approve
  if (req.method !== "GET" && req.headers["x-excalidraw-workspace"] !== "1") {
    throw new HttpError(403, "Missing workspace header");
  }
};

// -----------------------------------------------------------------------------
// workspace
// -----------------------------------------------------------------------------

type ClientEvent =
  | { type: "tree" }
  | { type: "meta" }
  | { type: "root" }
  | { type: "file"; path: string; hash: string; writerId: string | null };

class Workspace {
  root: string;
  private watcher: fs.FSWatcher | null = null;
  private clients = new Set<ServerResponse>();
  /** last content hash we know of per file, to only broadcast real changes */
  private knownHashes = new Map<string, string>();
  private pendingFileChecks = new Map<string, NodeJS.Timeout>();
  private treeTimer: NodeJS.Timeout | null = null;
  private metaWriteQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.root = resolveInitialRoot();
  }

  async ensureRoot() {
    await fsp.mkdir(this.root, { recursive: true });
  }

  resolve(relPath: string, { allowHidden = false } = {}) {
    if (typeof relPath !== "string") {
      throw new HttpError(400, "Missing path");
    }
    const segments = relPath.split("/").filter(Boolean);
    if (!allowHidden && segments.some((s) => s.startsWith(".") || s === "..")) {
      throw new HttpError(400, "Invalid path");
    }
    const abs = path.resolve(this.root, ...segments);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new HttpError(400, "Path escapes the workspace");
    }
    return abs;
  }

  relative(abs: string) {
    return toPosix(path.relative(this.root, abs));
  }

  // ---------------------------------------------------------------------------

  async tree(dir = this.root): Promise<TreeNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const stat = await fsp.stat(abs).catch(() => null);
        nodes.push({
          type: "folder",
          name: entry.name,
          path: this.relative(abs),
          mtime: stat?.mtimeMs ?? 0,
          children: await this.tree(abs),
        });
      } else if (entry.isFile() && entry.name.endsWith(FILE_EXT)) {
        const stat = await fsp.stat(abs).catch(() => null);
        nodes.push({
          type: "file",
          name: entry.name.slice(0, -FILE_EXT.length),
          path: this.relative(abs),
          mtime: stat?.mtimeMs ?? 0,
        });
      }
    }
    nodes.sort((a, b) =>
      a.type !== b.type
        ? a.type === "folder"
          ? -1
          : 1
        : naturalCompare(a.name, b.name),
    );
    return nodes;
  }

  async readMeta(): Promise<WorkspaceMeta> {
    try {
      const raw = JSON.parse(
        await fsp.readFile(path.join(this.root, META_FILE), "utf8"),
      );
      return {
        ...EMPTY_META,
        ...raw,
        icons: raw.icons || {},
        favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      };
    } catch {
      return { ...EMPTY_META };
    }
  }

  /** serialized read-modify-write of the meta file */
  updateMeta(
    update: (meta: WorkspaceMeta) => WorkspaceMeta | void,
  ): Promise<WorkspaceMeta> {
    const run = async () => {
      const meta = await this.readMeta();
      const next = update(meta) || meta;
      await fsp.writeFile(
        path.join(this.root, META_FILE),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      return next;
    };
    const result = this.metaWriteQueue.then(run, run);
    this.metaWriteQueue = result.catch(() => {});
    return result;
  }

  /** keeps icons/favorites/lastOpened pointing at moved paths */
  private remapMetaPaths(from: string, to: string | null) {
    const remap = (p: string) => {
      if (p === from) {
        return to;
      }
      if (p.startsWith(`${from}/`)) {
        return to ? `${to}${p.slice(from.length)}` : null;
      }
      return p;
    };
    return this.updateMeta((meta) => {
      const icons: Record<string, string> = {};
      for (const [p, icon] of Object.entries(meta.icons)) {
        const next = remap(p);
        if (next) {
          icons[next] = icon;
        }
      }
      return {
        ...meta,
        icons,
        favorites: meta.favorites.map(remap).filter((p): p is string => !!p),
        lastOpened: meta.lastOpened ? remap(meta.lastOpened) : null,
      };
    });
  }

  async uniquePath(dirAbs: string, baseName: string, ext: string) {
    let candidate = path.join(dirAbs, `${baseName}${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dirAbs, `${baseName} ${n}${ext}`);
      n++;
    }
    return candidate;
  }

  async readFile(relPath: string) {
    const abs = this.resolve(relPath);
    if (!abs.endsWith(FILE_EXT)) {
      throw new HttpError(400, "Not an .excalidraw file");
    }
    const text = await fsp.readFile(abs, "utf8").catch(() => {
      throw new HttpError(404, "File not found");
    });
    return { text, hash: sha1(text) };
  }

  async writeFile(relPath: string, text: string, writerId: string | null) {
    const abs = this.resolve(relPath);
    if (!abs.endsWith(FILE_EXT)) {
      throw new HttpError(400, "Not an .excalidraw file");
    }
    try {
      JSON.parse(text);
    } catch {
      throw new HttpError(400, "Refusing to write invalid JSON");
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const hash = sha1(text);
    // set before writing so the watcher doesn't re-announce our own write
    this.knownHashes.set(relPath, hash);
    await fsp.writeFile(abs, text);
    const stat = await fsp.stat(abs);
    // other tabs/windows with this page open pick the change up live
    this.broadcast({ type: "file", path: relPath, hash, writerId });
    return { hash, mtime: stat.mtimeMs };
  }

  async create(
    parent: string,
    name: string,
    kind: "file" | "folder",
    content?: string,
  ) {
    if (!isValidName(name)) {
      throw new HttpError(400, `Invalid name: ${name}`);
    }
    const dirAbs = this.resolve(parent || "");
    await fsp.mkdir(dirAbs, { recursive: true });
    if (kind === "folder") {
      const abs = await this.uniquePath(dirAbs, name, "");
      await fsp.mkdir(abs);
      return { path: this.relative(abs) };
    }
    const abs = await this.uniquePath(dirAbs, name, FILE_EXT);
    await fsp.writeFile(abs, content ?? emptyScene());
    return { path: this.relative(abs) };
  }

  async move(from: string, toParent: string, newName?: string) {
    const fromAbs = this.resolve(from);
    if (fromAbs === this.root) {
      throw new HttpError(400, "Can't move the workspace root");
    }
    const stat = await fsp.stat(fromAbs).catch(() => {
      throw new HttpError(404, "Not found");
    });
    const isDir = stat.isDirectory();
    const ext = isDir ? "" : FILE_EXT;
    const currentName = path.basename(fromAbs, ext);
    const name = newName ?? currentName;
    if (!isValidName(name)) {
      throw new HttpError(400, `Invalid name: ${name}`);
    }
    const toDirAbs = this.resolve(toParent || "");
    if (
      isDir &&
      (toDirAbs === fromAbs || toDirAbs.startsWith(fromAbs + path.sep))
    ) {
      throw new HttpError(400, "Can't move a folder into itself");
    }
    let toAbs = path.join(toDirAbs, `${name}${ext}`);
    if (toAbs === fromAbs) {
      return { path: from };
    }
    // allow case-only renames, otherwise never overwrite
    if (fs.existsSync(toAbs) && toAbs.toLowerCase() !== fromAbs.toLowerCase()) {
      toAbs = await this.uniquePath(toDirAbs, name, ext);
    }
    await fsp.mkdir(toDirAbs, { recursive: true });
    await fsp.rename(fromAbs, toAbs);
    const to = this.relative(toAbs);
    await this.remapMetaPaths(from, to);
    return { path: to };
  }

  async duplicate(relPath: string) {
    const abs = this.resolve(relPath);
    if (!abs.endsWith(FILE_EXT)) {
      throw new HttpError(400, "Only pages can be duplicated");
    }
    const target = await this.uniquePath(
      path.dirname(abs),
      `${path.basename(abs, FILE_EXT)} copy`,
      FILE_EXT,
    );
    await fsp.copyFile(abs, target);
    return { path: this.relative(target) };
  }

  // trash ---------------------------------------------------------------------

  private get trashAbs() {
    return path.join(this.root, TRASH_DIR);
  }

  async trash(relPath: string) {
    const abs = this.resolve(relPath);
    if (abs === this.root) {
      throw new HttpError(400, "Can't trash the workspace root");
    }
    await fsp.mkdir(this.trashAbs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // keep the original location in the trashed name to allow restoring
    const encoded = `${stamp}__${relPath.replace(/\//g, "∕")}`;
    await fsp.rename(abs, path.join(this.trashAbs, encoded));
    await this.remapMetaPaths(relPath, null);
    return { ok: true };
  }

  async listTrash() {
    const entries = await fsp
      .readdir(this.trashAbs, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[]);
    return entries
      .filter((e) => e.name.includes("__"))
      .map((e) => {
        const [stamp, original] = e.name.split(/__(.*)/s);
        const originalPath = original.replace(/∕/g, "/");
        return {
          id: e.name,
          originalPath,
          name: path.basename(originalPath, FILE_EXT),
          type: e.isDirectory() ? ("folder" as const) : ("file" as const),
          trashedAt: stamp,
        };
      })
      .sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : -1));
  }

  async restore(id: string) {
    const abs = path.join(this.trashAbs, path.basename(id));
    if (!fs.existsSync(abs)) {
      throw new HttpError(404, "Not in trash");
    }
    const original = id.split(/__(.*)/s)[1]?.replace(/∕/g, "/");
    if (!original) {
      throw new HttpError(400, "Unknown trash entry");
    }
    const target = this.resolve(original);
    const isDir = (await fsp.stat(abs)).isDirectory();
    const ext = isDir ? "" : FILE_EXT;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const finalAbs = fs.existsSync(target)
      ? await this.uniquePath(
          path.dirname(target),
          path.basename(target, ext),
          ext,
        )
      : target;
    await fsp.rename(abs, finalAbs);
    return { path: this.relative(finalAbs) };
  }

  async deleteFromTrash(id: string) {
    const abs = path.join(this.trashAbs, path.basename(id));
    if (!abs.startsWith(this.trashAbs + path.sep) || !fs.existsSync(abs)) {
      throw new HttpError(404, "Not in trash");
    }
    await fsp.rm(abs, { recursive: true, force: true });
    return { ok: true };
  }

  // live updates ----------------------------------------------------------------

  addClient(res: ServerResponse) {
    this.clients.add(res);
    const remove = () => this.clients.delete(res);
    res.on("close", remove);
    res.on("error", remove);
  }

  /** stop watching & drop live connections (server closing/restarting) */
  dispose() {
    this.watcher?.close();
    this.watcher = null;
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
    }
    for (const timer of this.pendingFileChecks.values()) {
      clearTimeout(timer);
    }
    this.pendingFileChecks.clear();
    for (const client of this.clients) {
      try {
        client.end();
      } catch {}
    }
    this.clients.clear();
  }

  broadcast(event: ClientEvent) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      if (client.writableEnded || client.destroyed) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private scheduleTreeBroadcast() {
    if (this.treeTimer) {
      clearTimeout(this.treeTimer);
    }
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      this.broadcast({ type: "tree" });
    }, 150);
  }

  private scheduleFileCheck(relPath: string) {
    const existing = this.pendingFileChecks.get(relPath);
    if (existing) {
      clearTimeout(existing);
    }
    this.pendingFileChecks.set(
      relPath,
      setTimeout(async () => {
        this.pendingFileChecks.delete(relPath);
        let text: string;
        try {
          text = await fsp.readFile(path.join(this.root, relPath), "utf8");
        } catch {
          return; // deleted/moved — the tree broadcast covers it
        }
        const hash = sha1(text);
        if (this.knownHashes.get(relPath) === hash) {
          // our own write, or a no-op rewrite (e.g. Drive re-syncing)
          return;
        }
        this.knownHashes.set(relPath, hash);
        // changed outside the app: Claude Code, another device via Drive, …
        this.broadcast({ type: "file", path: relPath, hash, writerId: null });
      }, 120),
    );
  }

  startWatching() {
    this.watcher?.close();
    this.watcher = null;
    try {
      this.watcher = fs.watch(
        this.root,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) {
            this.scheduleTreeBroadcast();
            return;
          }
          const rel = toPosix(filename.toString());
          if (rel === META_FILE) {
            this.broadcast({ type: "meta" });
            return;
          }
          if (rel.split("/").some((s) => s.startsWith("."))) {
            return; // trash, temp & hidden files
          }
          if (eventType === "rename" || !rel.endsWith(FILE_EXT)) {
            this.scheduleTreeBroadcast();
          }
          if (rel.endsWith(FILE_EXT)) {
            this.scheduleFileCheck(rel);
          }
        },
      );
      this.watcher.on("error", (error) => {
        console.warn("[workspace] watcher error", error);
      });
    } catch (error) {
      console.warn("[workspace] couldn't watch the workspace folder", error);
    }
  }

  async setRoot(nextRoot: string) {
    const resolved = path.resolve(nextRoot.replace(/^~(?=$|\/)/, os.homedir()));
    await fsp.mkdir(resolved, { recursive: true });
    this.root = resolved;
    this.knownHashes.clear();
    await fsp.writeFile(
      CONFIG_FILE,
      `${JSON.stringify({ ...readConfig(), root: resolved }, null, 2)}\n`,
    );
    this.startWatching();
    this.broadcast({ type: "root" });
    return this.info();
  }

  info() {
    return {
      root: this.root,
      ...describeRoot(this.root),
      ai: claudeAvailability(),
    };
  }
}

const emptyScene = () =>
  `${JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "excalidraw-workspace",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {},
    },
    null,
    2,
  )}\n`;

let claudeCheck: { available: boolean; version: string | null } | null = null;
const claudeAvailability = () => {
  if (!claudeCheck) {
    const bin = process.env.EXCALIDRAW_CLAUDE_BIN || "claude";
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    claudeCheck =
      result.status === 0
        ? { available: true, version: result.stdout.trim() }
        : { available: false, version: null };
  }
  return claudeCheck;
};

// -----------------------------------------------------------------------------
// routing
// -----------------------------------------------------------------------------

const createHandler = (workspace: Workspace) => {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (!url.pathname.startsWith(`${WORKSPACE_API_PREFIX}/`)) {
      return next();
    }
    const route = `${req.method} ${url.pathname.slice(
      WORKSPACE_API_PREFIX.length,
    )}`;
    const q = (key: string) => url.searchParams.get(key) || "";

    try {
      assertLocalRequest(req);
      await workspace.ensureRoot();

      switch (route) {
        case "GET /info":
          return sendJSON(res, 200, workspace.info());

        case "GET /events": {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          workspace.addClient(res);
          const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
          res.on("close", () => clearInterval(heartbeat));
          return;
        }

        case "GET /tree":
          return sendJSON(res, 200, {
            tree: await workspace.tree(),
            meta: await workspace.readMeta(),
          });

        case "GET /file": {
          const { text, hash } = await workspace.readFile(q("path"));
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Content-Hash", hash);
          return res.end(text);
        }

        case "PUT /file": {
          const text = await readBody(req);
          const writerId =
            (req.headers["x-workspace-client"] as string | undefined) || null;
          return sendJSON(
            res,
            200,
            await workspace.writeFile(q("path"), text, writerId),
          );
        }

        case "POST /create": {
          const body = await readJSONBody<{
            parent: string;
            name: string;
            kind: "file" | "folder";
            content?: string;
          }>(req);
          return sendJSON(
            res,
            200,
            await workspace.create(
              body.parent,
              body.name,
              body.kind,
              body.content,
            ),
          );
        }

        case "POST /move": {
          const body = await readJSONBody<{
            from: string;
            toParent: string;
            name?: string;
          }>(req);
          return sendJSON(
            res,
            200,
            await workspace.move(body.from, body.toParent, body.name),
          );
        }

        case "POST /duplicate": {
          const body = await readJSONBody<{ path: string }>(req);
          return sendJSON(res, 200, await workspace.duplicate(body.path));
        }

        case "POST /trash": {
          const body = await readJSONBody<{ path: string }>(req);
          return sendJSON(res, 200, await workspace.trash(body.path));
        }

        case "GET /trash":
          return sendJSON(res, 200, { items: await workspace.listTrash() });

        case "POST /restore": {
          const body = await readJSONBody<{ id: string }>(req);
          return sendJSON(res, 200, await workspace.restore(body.id));
        }

        case "POST /delete-forever": {
          const body = await readJSONBody<{ id: string }>(req);
          return sendJSON(res, 200, await workspace.deleteFromTrash(body.id));
        }

        case "POST /meta": {
          const patch = await readJSONBody<Partial<WorkspaceMeta>>(req);
          const meta = await workspace.updateMeta((meta) => ({
            ...meta,
            ...(patch.icons ? { icons: patch.icons } : {}),
            ...(patch.favorites ? { favorites: patch.favorites } : {}),
            ...(patch.lastOpened !== undefined
              ? { lastOpened: patch.lastOpened }
              : {}),
          }));
          return sendJSON(res, 200, meta);
        }

        case "POST /root": {
          const body = await readJSONBody<{ root: string }>(req);
          if (!body.root || !path.isAbsolute(body.root.replace(/^~/, "/"))) {
            throw new HttpError(400, "Provide an absolute folder path");
          }
          return sendJSON(res, 200, await workspace.setRoot(body.root));
        }

        case "POST /reveal": {
          const body = await readJSONBody<{ path?: string }>(req);
          const target = workspace.resolve(body.path || "");
          if (process.platform === "darwin") {
            spawn("open", body.path ? ["-R", target] : [target], {
              stdio: "ignore",
              detached: true,
            })
              .on("error", () => {})
              .unref();
          }
          return sendJSON(res, 200, { ok: true, path: target });
        }

        case "POST /ai": {
          if (!claudeAvailability().available) {
            throw new HttpError(
              503,
              "The `claude` CLI wasn't found on this computer.",
            );
          }
          const body = await readJSONBody<{
            prompt: string;
            context: string;
            history?: { role: "user" | "assistant"; text: string }[];
            model?: string;
          }>(req);
          const controller = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) {
              controller.abort();
            }
          });
          const result = await runClaudePrompt({
            ...body,
            signal: controller.signal,
          });
          return sendJSON(res, 200, result);
        }

        default:
          throw new HttpError(404, `Unknown workspace route: ${route}`);
      }
    } catch (error: any) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) {
        console.error("[workspace]", error);
      }
      if (!res.headersSent) {
        sendJSON(res, status, { error: error?.message || "Unknown error" });
      } else {
        res.end();
      }
    }
  };
};

export const workspacePlugin = (): Plugin => {
  let workspace: Workspace | null = null;

  const attach = (server: ViteDevServer | PreviewServer) => {
    if (!workspace) {
      workspace = new Workspace();
      workspace
        .ensureRoot()
        .then(() => {
          workspace!.startWatching();
          // eslint-disable-next-line no-console
          console.log(`\n  📁 Excalidraw workspace: ${workspace!.root}\n`);
        })
        .catch((error) => {
          console.error("[workspace] can't create workspace folder", error);
        });
    }
    server.middlewares.use(createHandler(workspace));
    // Vite restarts the server when its config (or this file) changes:
    // release the folder watcher & live connections of this instance
    const current = workspace;
    server.httpServer?.once("close", () => current.dispose());
  };

  return {
    name: "excalidraw-local-workspace",
    configureServer: attach,
    configurePreviewServer: attach,
  };
};
