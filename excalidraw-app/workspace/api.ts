/**
 * Client for the local workspace server (see `server/workspacePlugin.ts`).
 */

export const WORKSPACE_API = "/__workspace";

export type TreeNode = {
  type: "folder" | "file";
  name: string;
  path: string;
  mtime: number;
  children?: TreeNode[];
};

export type WorkspaceMeta = {
  version: 1;
  icons: Record<string, string>;
  favorites: string[];
  lastOpened: string | null;
};

export type WorkspaceInfo = {
  root: string;
  label: string;
  isGoogleDrive: boolean;
  ai: { available: boolean; version: string | null };
};

export type TrashItem = {
  id: string;
  originalPath: string;
  name: string;
  type: "file" | "folder";
  trashedAt: string;
};

export type WorkspaceEvent =
  | { type: "tree" }
  | { type: "meta" }
  | { type: "root" }
  | { type: "file"; path: string; hash: string; writerId: string | null };

export type AIOp =
  | { op: "add"; elements: Record<string, any>[] }
  | { op: "update"; updates: ({ id: string } & Record<string, any>)[] }
  | { op: "delete"; ids: string[] };

export type AIResult = {
  message: string;
  ops: AIOp[];
  durationMs: number;
  model: string;
};

export const CLIENT_ID = Math.random().toString(36).slice(2);

const request = async <T>(
  route: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> => {
  const { json, ...rest } = init;
  const res = await fetch(`${WORKSPACE_API}${route}`, {
    ...rest,
    headers: {
      "x-excalidraw-workspace": "1",
      "x-workspace-client": CLIENT_ID,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Workspace server returned an unexpected response`);
  }
  if (!res.ok) {
    throw new Error(data?.error || `Workspace request failed (${res.status})`);
  }
  return data as T;
};

const post = <T>(route: string, json: unknown, signal?: AbortSignal) =>
  request<T>(route, { method: "POST", json, signal });

export const workspaceApi = {
  /** null when the app isn't served by the workspace server (e.g. prod) */
  info: async (): Promise<WorkspaceInfo | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${WORKSPACE_API}/info`, {
        signal: controller.signal,
      });
      if (
        !res.ok ||
        !res.headers.get("content-type")?.includes("application/json")
      ) {
        return null;
      }
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  tree: () => request<{ tree: TreeNode[]; meta: WorkspaceMeta }>("/tree"),

  readFile: async (path: string) => {
    const res = await fetch(
      `${WORKSPACE_API}/file?path=${encodeURIComponent(path)}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      let message = `Couldn't open ${path}`;
      try {
        message = (await res.json()).error || message;
      } catch {}
      throw new Error(message);
    }
    return {
      text: await res.text(),
      hash: res.headers.get("X-Content-Hash") || "",
    };
  },

  writeFile: (path: string, text: string, opts?: { keepalive?: boolean }) =>
    request<{ hash: string; mtime: number }>(
      `/file?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        body: text,
        headers: { "Content-Type": "application/json" },
        keepalive: opts?.keepalive,
      },
    ),

  create: (opts: {
    parent: string;
    name: string;
    kind: "file" | "folder";
    content?: string;
  }) => post<{ path: string }>("/create", opts),

  move: (from: string, toParent: string, name?: string) =>
    post<{ path: string }>("/move", { from, toParent, name }),

  duplicate: (path: string) => post<{ path: string }>("/duplicate", { path }),

  trash: (path: string) => post<{ ok: true }>("/trash", { path }),
  listTrash: () => request<{ items: TrashItem[] }>("/trash"),
  restore: (id: string) => post<{ path: string }>("/restore", { id }),
  deleteForever: (id: string) => post<{ ok: true }>("/delete-forever", { id }),

  setMeta: (patch: Partial<WorkspaceMeta>) =>
    post<WorkspaceMeta>("/meta", patch),

  setRoot: (root: string) => post<WorkspaceInfo>("/root", { root }),

  reveal: (path?: string) => post<{ ok: true }>("/reveal", { path }),

  ai: (
    body: {
      prompt: string;
      context: string;
      history: { role: "user" | "assistant"; text: string }[];
      model: string;
    },
    signal?: AbortSignal,
  ) => post<AIResult>("/ai", body, signal),

  subscribe: (onEvent: (event: WorkspaceEvent) => void) => {
    const source = new EventSource(`${WORKSPACE_API}/events`);
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
  },
};

// path helpers ----------------------------------------------------------------

export const FILE_EXT = ".excalidraw";

export const dirname = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export const basename = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(FILE_EXT) ? name.slice(0, -FILE_EXT.length) : name;
};

export const isInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`);
