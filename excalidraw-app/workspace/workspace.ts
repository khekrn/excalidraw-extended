/**
 * Workspace controller: keeps the open page (a `.excalidraw` file in the
 * workspace folder) in sync with the editor — loads pages, autosaves edits,
 * and live-reloads changes made on disk (Claude Code, other tabs, Google
 * Drive syncing from another device).
 */
import {
  CaptureUpdateAction,
  getNonDeletedElements,
  hashElementsVersion,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import { getCommonBounds } from "@excalidraw/element";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import type { Bounds } from "@excalidraw/common";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { appJotaiStore, atom } from "../app-jotai";

import { basename, CLIENT_ID, dirname, isInside, workspaceApi } from "./api";

import type {
  TreeNode,
  WorkspaceEvent,
  WorkspaceInfo,
  WorkspaceMeta,
} from "./api";

// -----------------------------------------------------------------------------
// state
// -----------------------------------------------------------------------------

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export const workspaceInfoAtom = atom<WorkspaceInfo | null>(null);
export const workspaceTreeAtom = atom<TreeNode[]>([]);
export const workspaceMetaAtom = atom<WorkspaceMeta>({
  version: 1,
  icons: {},
  favorites: [],
  lastOpened: null,
});
export const currentPageAtom = atom<string | null>(null);
export const saveStatusAtom = atom<SaveStatus>("idle");
export const saveErrorAtom = atom<string | null>(null);
/** the canvas holds a drawing that isn't saved to any page */
export const detachedAtom = atom<boolean>(false);

const PANEL_OPEN_KEY = "excalidraw-workspace-panel-open";
const ADOPTED_KEY = "excalidraw-workspace-adopted";

const readPanelOpen = () => {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
};
export const workspacePanelOpenAtom = atom<boolean>(readPanelOpen());
export const setWorkspacePanelOpen = (open: boolean) => {
  appJotaiStore.set(workspacePanelOpenAtom, open);
  try {
    localStorage.setItem(PANEL_OPEN_KEY, String(open));
  } catch {}
};

// -----------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 700;
const SAVE_MAX_WAIT_MS = 4000;

const SCENE_APPSTATE_KEYS = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "lockedMultiSelections",
] as const;

type SceneAppState = Pick<AppState, typeof SCENE_APPSTATE_KEYS[number]>;

type ParsedScene = {
  elements: ExcalidrawElement[];
  appState: SceneAppState;
  files: BinaryFiles;
};

export const parseScene = (text: string): ParsedScene => {
  const data = JSON.parse(text);
  if (data?.type !== "excalidraw" || !Array.isArray(data.elements)) {
    throw new Error("Not a valid .excalidraw file");
  }
  const restored = restoreAppState(data.appState, null);
  const appState: SceneAppState = {
    viewBackgroundColor: restored.viewBackgroundColor,
    gridSize: restored.gridSize,
    gridStep: restored.gridStep,
    gridModeEnabled: restored.gridModeEnabled,
    lockedMultiSelections: restored.lockedMultiSelections,
  };
  return {
    elements: restoreElements(data.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }) as ExcalidrawElement[],
    appState,
    files: data.files || {},
  };
};

/**
 * What to show when a page opens: all of it, or for a tall page (e.g. an
 * imported document) its top, at a readable zoom.
 */
const pageViewport = (
  elements: readonly ExcalidrawElement[],
  api: ExcalidrawImperativeAPI,
): Bounds | readonly ExcalidrawElement[] => {
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const { width: viewportWidth, height: viewportHeight } = api.getAppState();
  const width = maxX - minX;
  const height = maxY - minY;
  if (!viewportWidth || !viewportHeight || width <= 0) {
    return elements;
  }
  const aspect = viewportHeight / viewportWidth;
  if (height < width * aspect * 1.6) {
    return elements;
  }
  const pad = 48;
  const boxWidth = width + pad * 2;
  return [
    minX - pad,
    minY - pad,
    maxX + pad,
    minY - pad + boxWidth * aspect,
  ] as Bounds;
};

const sceneKey = (
  elements: readonly ExcalidrawElement[],
  viewBackgroundColor: string,
) => `${hashElementsVersion(elements)}:${viewBackgroundColor}`;

const flattenFiles = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((node) =>
    node.type === "file" ? [node] : flattenFiles(node.children || []),
  );

export const findNode = (nodes: TreeNode[], path: string): TreeNode | null => {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.children && isInside(path, node.path)) {
      const found = findNode(node.children, path);
      if (found) {
        return found;
      }
    }
  }
  return null;
};

class WorkspaceController {
  private api: ExcalidrawImperativeAPI | null = null;
  private initPromise: Promise<boolean> | null = null;
  private currentPath: string | null = null;
  /** hashes of contents we wrote/loaded, to ignore their change echoes */
  private knownHashes: string[] = [];
  private lastSavedKey: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingChangeAt = 0;
  private saveChain: Promise<void> = Promise.resolve();
  private isCollaborating: () => boolean = () => false;
  /** file operations started from the app (their tree events are expected) */
  private opsInFlight = 0;
  enabled = false;

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.opsInFlight++;
    try {
      return await fn();
    } finally {
      // let the watcher's events for this operation arrive first
      setTimeout(() => this.opsInFlight--, 1000);
    }
  }

  setAPI(api: ExcalidrawImperativeAPI | null) {
    this.api = api;
  }

  setCollaborationCheck(check: () => boolean) {
    this.isCollaborating = check;
  }

  getCurrentPath() {
    return this.currentPath;
  }

  init(): Promise<boolean> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const info = await workspaceApi.info();
        if (!info) {
          return false;
        }
        this.enabled = true;
        appJotaiStore.set(workspaceInfoAtom, info);
        await this.refreshTree();
        workspaceApi.subscribe((event) => this.onEvent(event));
        return true;
      })();
    }
    return this.initPromise;
  }

  async refreshTree() {
    const { tree, meta } = await workspaceApi.tree();
    appJotaiStore.set(workspaceTreeAtom, tree);
    appJotaiStore.set(workspaceMetaAtom, meta);
    return { tree, meta };
  }

  private setCurrent(path: string | null, hash?: string) {
    this.currentPath = path;
    if (hash) {
      this.rememberHash(hash);
    }
    appJotaiStore.set(currentPageAtom, path);
    appJotaiStore.set(detachedAtom, !path);
    appJotaiStore.set(saveStatusAtom, path ? "saved" : "idle");
    appJotaiStore.set(saveErrorAtom, null);
    document.title = path ? `${basename(path)} · Excalidraw` : "Excalidraw";
  }

  private rememberHash(hash: string) {
    this.knownHashes.push(hash);
    if (this.knownHashes.length > 30) {
      this.knownHashes.shift();
    }
  }

  private toast(message: string) {
    this.api?.setToast({ message, closable: true, duration: 4000 });
  }

  // initial load ----------------------------------------------------------------

  /**
   * Returns the scene to start the editor with: the last opened page, or
   * null to keep the browser-stored scene (shown as an unsaved drawing).
   */
  async getInitialScene(
    localScene: ExcalidrawInitialDataState | null,
  ): Promise<ExcalidrawInitialDataState | null> {
    const { tree, meta } = await this.refreshTree();
    const files = flattenFiles(tree);
    const localHasContent = !!localScene?.elements?.some((el) => !el.isDeleted);

    let adopted = false;
    try {
      adopted = localStorage.getItem(ADOPTED_KEY) === "true";
    } catch {}

    // first run with an existing browser drawing: don't replace it, offer to
    // save it as a page instead
    if (!adopted && localHasContent) {
      this.setCurrent(null);
      return null;
    }
    this.markAdopted();

    let path =
      meta.lastOpened && files.some((f) => f.path === meta.lastOpened)
        ? meta.lastOpened
        : [...files].sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;

    if (!path) {
      path = (
        await workspaceApi.create({
          parent: "",
          name: "Untitled",
          kind: "file",
        })
      ).path;
      await this.refreshTree();
    }

    try {
      const { text, hash } = await workspaceApi.readFile(path);
      const scene = parseScene(text);
      this.setCurrent(path, hash);
      this.lastSavedKey = sceneKey(
        scene.elements,
        scene.appState.viewBackgroundColor || "#ffffff",
      );
      return {
        elements: scene.elements,
        appState: {
          ...localScene?.appState,
          ...scene.appState,
          name: basename(path),
        },
        files: scene.files,
        scrollToContent: true,
      };
    } catch (error: any) {
      console.error(error);
      this.setCurrent(null);
      return null;
    }
  }

  markAdopted() {
    try {
      localStorage.setItem(ADOPTED_KEY, "true");
    } catch {}
  }

  // saving ------------------------------------------------------------------

  /** called from the editor's onChange (hot path — keep it cheap) */
  onSceneChange() {
    if (!this.currentPath) {
      return;
    }
    const now = Date.now();
    if (!this.saveTimer) {
      this.firstPendingChangeAt = now;
    } else {
      clearTimeout(this.saveTimer);
    }
    const wait =
      now - this.firstPendingChangeAt > SAVE_MAX_WAIT_MS ? 0 : SAVE_DEBOUNCE_MS;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueSave();
    }, wait);
  }

  private queueSave(opts?: { keepalive?: boolean }) {
    this.saveChain = this.saveChain.then(() => this.save(opts));
    return this.saveChain;
  }

  private async save(opts?: { keepalive?: boolean }) {
    const path = this.currentPath;
    const api = this.api;
    if (!path || !api) {
      return;
    }
    const elements = api.getSceneElementsIncludingDeleted();
    const appState = api.getAppState();
    const key = sceneKey(elements, appState.viewBackgroundColor);
    if (key === this.lastSavedKey) {
      return;
    }
    const text = serializeAsJSON(
      getNonDeletedElements(elements),
      appState,
      api.getFiles(),
      "local",
    );
    appJotaiStore.set(saveStatusAtom, "saving");
    try {
      const { hash } = await workspaceApi.writeFile(path, text, {
        // browsers cap keepalive request bodies at 64KB
        keepalive: !!opts?.keepalive && text.length < 60_000,
      });
      this.rememberHash(hash);
      if (this.currentPath === path) {
        this.lastSavedKey = key;
        appJotaiStore.set(saveStatusAtom, "saved");
        appJotaiStore.set(saveErrorAtom, null);
      }
    } catch (error: any) {
      appJotaiStore.set(saveStatusAtom, "error");
      appJotaiStore.set(saveErrorAtom, error.message);
    }
  }

  hasPendingChanges() {
    return !!this.saveTimer;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.queueSave();
    } else {
      await this.saveChain;
    }
  }

  /** best-effort save while the tab closes; true if it may not have made it */
  flushOnUnload(): boolean {
    if (!this.saveTimer || !this.currentPath || !this.api) {
      return false;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.queueSave({ keepalive: true });
    // keepalive requests are capped at 64KB
    return true;
  }

  // pages -------------------------------------------------------------------

  private applyScene(
    scene: ParsedScene,
    path: string,
    opts: { reload: boolean },
  ) {
    const api = this.api!;
    if (opts.reload) {
      // keep the selection; undoable, so ⌘Z restores the previous state
      api.updateScene({
        elements: scene.elements,
        appState: { ...scene.appState, name: basename(path) },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    } else {
      api.updateScene({
        elements: scene.elements,
        appState: {
          ...scene.appState,
          name: basename(path),
          selectedElementIds: {},
          selectedGroupIds: {},
          editingGroupId: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    const files = Object.values(scene.files || {}) as BinaryFileData[];
    if (files.length) {
      api.addFiles(files);
    }
    this.lastSavedKey = sceneKey(
      api.getSceneElementsIncludingDeleted(),
      scene.appState.viewBackgroundColor || "#ffffff",
    );
    if (!opts.reload) {
      api.history.clear();
      const visible = scene.elements.filter((el) => !el.isDeleted);
      if (visible.length) {
        api.setViewport({
          target: pageViewport(visible, api),
          fit: "scale-down",
        });
      } else {
        api.updateScene({
          appState: { scrollX: 0, scrollY: 0 },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    }
  }

  async openPage(path: string) {
    if (!this.api || path === this.currentPath) {
      return;
    }
    if (this.isCollaborating()) {
      this.toast("Stop the live collaboration session to switch pages.");
      return;
    }
    await this.flush();
    const previous = this.currentPath;
    // stop autosaving while the scene is swapped
    this.currentPath = null;
    try {
      const { text, hash } = await workspaceApi.readFile(path);
      const scene = parseScene(text);
      this.applyScene(scene, path, { reload: false });
      this.setCurrent(path, hash);
      this.markAdopted();
      workspaceApi.setMeta({ lastOpened: path }).catch(() => {});
    } catch (error: any) {
      this.currentPath = previous;
      this.toast(error.message || `Couldn't open ${basename(path)}`);
    }
  }

  async createPage(
    parent = "",
    name = "Untitled",
    content?: string,
    opts: { open?: boolean } = {},
  ) {
    if (this.isCollaborating()) {
      this.toast("Stop the live collaboration session to create pages.");
      return null;
    }
    const { path } = await workspaceApi.create({
      parent,
      name,
      kind: "file",
      content,
    });
    await this.refreshTree();
    if (opts.open !== false) {
      await this.openPage(path);
    }
    return path;
  }

  async createFolder(parent = "", name = "New folder") {
    const { path } = await workspaceApi.create({
      parent,
      name,
      kind: "folder",
    });
    await this.refreshTree();
    return path;
  }

  /** saves whatever is on the canvas as a new page and switches to it */
  async saveCanvasAsPage(name = "Untitled", parent = "") {
    const api = this.api;
    if (!api) {
      return null;
    }
    const text = serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      "local",
    );
    const { path } = await workspaceApi.create({
      parent,
      name,
      kind: "file",
      content: text,
    });
    this.markAdopted();
    this.setCurrent(path);
    this.lastSavedKey = sceneKey(
      api.getSceneElementsIncludingDeleted(),
      api.getAppState().viewBackgroundColor,
    );
    api.updateScene({
      appState: { name: basename(path) },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    workspaceApi.setMeta({ lastOpened: path }).catch(() => {});
    await this.refreshTree();
    return path;
  }

  /** stop syncing the canvas to the current page (e.g. joining a room) */
  detach() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.enabled) {
      this.setCurrent(null);
    }
  }

  rename(path: string, name: string) {
    return this.track(async () => {
      const { path: next } = await workspaceApi.move(path, dirname(path), name);
      this.onMoved(path, next);
      return next;
    });
  }

  move(path: string, toFolder: string) {
    return this.track(async () => {
      const { path: next } = await workspaceApi.move(path, toFolder);
      this.onMoved(path, next);
      return next;
    });
  }

  private onMoved(from: string, to: string) {
    if (this.currentPath && isInside(this.currentPath, from)) {
      const nextCurrent = `${to}${this.currentPath.slice(from.length)}`;
      this.currentPath = nextCurrent;
      appJotaiStore.set(currentPageAtom, nextCurrent);
      document.title = `${basename(nextCurrent)} · Excalidraw`;
      this.api?.updateScene({
        appState: { name: basename(nextCurrent) },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    this.refreshTree();
  }

  async duplicate(path: string) {
    await this.flush();
    const { path: copy } = await workspaceApi.duplicate(path);
    await this.refreshTree();
    return copy;
  }

  trash(path: string) {
    return this.track(() => this._trash(path));
  }

  private async _trash(path: string) {
    if (this.currentPath && isInside(this.currentPath, path)) {
      await this.flush();
      this.detach();
      await workspaceApi.trash(path);
      const { tree } = await this.refreshTree();
      const next = [...flattenFiles(tree)].sort((a, b) => b.mtime - a.mtime)[0];
      if (next) {
        await this.openPage(next.path);
      } else {
        this.api?.resetScene();
        await this.createPage("", "Untitled");
      }
    } else {
      await workspaceApi.trash(path);
      await this.refreshTree();
    }
  }

  async setMeta(patch: Partial<WorkspaceMeta>) {
    const meta = await workspaceApi.setMeta(patch);
    appJotaiStore.set(workspaceMetaAtom, meta);
  }

  async changeRoot(root: string) {
    await this.flush();
    const info = await workspaceApi.setRoot(root);
    appJotaiStore.set(workspaceInfoAtom, info);
    this.detach();
    const { tree } = await this.refreshTree();
    const first = [...flattenFiles(tree)].sort((a, b) => b.mtime - a.mtime)[0];
    if (first) {
      await this.openPage(first.path);
    } else {
      await this.saveCanvasAsPage("Untitled");
    }
  }

  // live updates --------------------------------------------------------------

  private async onEvent(event: WorkspaceEvent) {
    switch (event.type) {
      case "tree":
      case "meta": {
        const result = await this.refreshTree().catch(() => null);
        // the open page may have been moved/deleted outside the app
        if (
          result &&
          event.type === "tree" &&
          this.currentPath &&
          !this.opsInFlight
        ) {
          if (!findNode(result.tree, this.currentPath)) {
            this.toast(
              `"${basename(
                this.currentPath,
              )}" was moved or deleted outside the app — it's now unsaved.`,
            );
            this.detach();
          }
        }
        break;
      }
      case "root":
        appJotaiStore.set(workspaceInfoAtom, await workspaceApi.info());
        this.refreshTree().catch(() => {});
        break;
      case "file":
        if (
          event.path !== this.currentPath ||
          event.writerId === CLIENT_ID ||
          this.knownHashes.includes(event.hash)
        ) {
          return;
        }
        await this.reloadCurrentFromDisk(event.path);
        break;
    }
  }

  private async reloadCurrentFromDisk(path: string) {
    if (!this.api) {
      return;
    }
    try {
      const { text, hash } = await workspaceApi.readFile(path);
      if (this.currentPath !== path || this.knownHashes.includes(hash)) {
        return;
      }
      const scene = parseScene(text);
      // the disk version wins over unsaved local edits
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.rememberHash(hash);
      this.applyScene(scene, path, { reload: true });
      this.toast(`Page updated from disk (⌘Z to undo)`);
    } catch (error) {
      // a half-written file (mid-save by another program) — the next change
      // event will bring the complete version
      console.warn("[workspace] couldn't reload page", error);
    }
  }
}

export const workspace = new WorkspaceController();
