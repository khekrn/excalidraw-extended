import clsx from "clsx";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { useAtomValue } from "../app-jotai";
import {
  PAGE_IMPORT_ACCEPT,
  dragHasFiles,
  importFilesAsPages,
  pickFiles,
} from "../import/importFiles";

import { getDeckMeta, pageCount } from "../slides/deck";

import { basename, dirname, isInside, workspaceApi } from "./api";
import { DeckPicker } from "./DeckPicker";
import { createDeckPage, refreshDeck } from "./decks";
import {
  currentPageAtom,
  detachedAtom,
  saveErrorAtom,
  saveStatusAtom,
  setWorkspacePanelOpen,
  workspace,
  workspaceInfoAtom,
  workspaceMetaAtom,
  workspacePanelOpenAtom,
  workspaceTreeAtom,
} from "./workspace";

import "./WorkspacePanel.scss";

import type { DeckMeta } from "../slides/deck";
import type { TrashItem, TreeNode } from "./api";
import type { DeckRequest } from "./DeckPicker";

// -----------------------------------------------------------------------------
// icons
// -----------------------------------------------------------------------------

const svg = (children: React.ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const sidebarToggleIcon = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
const pageIcon = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>,
);
const folderIcon = svg(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);
const chevronIcon = svg(<path d="m9 6 6 6-6 6" />, 14);
const plusIcon = svg(<path d="M12 5v14M5 12h14" />);
const dotsIcon = svg(
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
);
const searchIcon = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);
const trashIcon = svg(
  <>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </>,
);
const starIcon = svg(
  <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />,
);
const collapseIcon = svg(<path d="m15 6-6 6 6 6M20 6l-6 6 6 6" />);
const deckIcon = svg(
  <>
    <rect x="3" y="4" width="14" height="10" rx="1.5" />
    <path d="M7 18h12.5a1.5 1.5 0 0 0 1.5-1.5V8" />
  </>,
);
const cloudIcon = svg(
  <path d="M7 18a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.7 8 4 4 0 0 1 17 18z" />,
  14,
);

const EMOJIS = [
  "📄",
  "📝",
  "📌",
  "📎",
  "📊",
  "📈",
  "🗂️",
  "📁",
  "🗒️",
  "📚",
  "🎨",
  "🖌️",
  "✏️",
  "🧠",
  "💡",
  "🚀",
  "🎯",
  "⭐",
  "🔥",
  "✅",
  "🧩",
  "⚙️",
  "🛠️",
  "🧪",
  "🔒",
  "🌐",
  "☁️",
  "💾",
  "🖥️",
  "📱",
  "🗺️",
  "🏗️",
  "🧭",
  "📅",
  "⏱️",
  "💬",
  "👥",
  "🤝",
  "💼",
  "🏠",
  "🐞",
  "🔍",
  "🎓",
  "🎬",
  "🎵",
  "🌱",
  "🍀",
  "❤️",
  "🟢",
  "🟣",
];

// -----------------------------------------------------------------------------
// popover menu
// -----------------------------------------------------------------------------

type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      danger?: boolean;
      hint?: string;
    }
  | "separator";

type MenuState = {
  x: number;
  y: number;
  content: React.ReactNode;
} | null;

const Popover = ({
  state,
  onClose,
  dark,
}: {
  state: NonNullable<MenuState>;
  onClose: () => void;
  dark: boolean;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - rect.width - 8),
      y: Math.min(state.y, window.innerHeight - rect.height - 8),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={clsx("ws-popover", { "ws-theme-dark": dark })}
      style={{ left: pos.x, top: pos.y }}
    >
      {state.content}
    </div>,
    document.body,
  );
};

const MenuList = ({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) => (
  <div className="ws-menu" role="menu">
    {items.map((item, i) =>
      item === "separator" ? (
        <div key={i} className="ws-menu__separator" />
      ) : (
        <button
          key={i}
          role="menuitem"
          className={clsx("ws-menu__item", { "is-danger": item.danger })}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.hint && <span className="ws-menu__hint">{item.hint}</span>}
        </button>
      ),
    )}
  </div>
);

const EmojiPicker = ({
  onPick,
}: {
  onPick: (emoji: string | null) => void;
}) => (
  <div className="ws-emoji">
    <div className="ws-emoji__grid">
      {EMOJIS.map((emoji) => (
        <button key={emoji} onClick={() => onPick(emoji)}>
          {emoji}
        </button>
      ))}
    </div>
    <button className="ws-emoji__remove" onClick={() => onPick(null)}>
      Remove icon
    </button>
  </div>
);

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const EXPANDED_KEY = "excalidraw-workspace-expanded";
const WIDTH_KEY = "excalidraw-workspace-width";

const loadExpanded = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const loadWidth = () => {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return width >= 200 && width <= 480 ? width : 264;
  } catch {
    return 264;
  }
};

const flatten = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children || [])]);

const DRAG_TYPE = "application/x-excalidraw-workspace-path";

const formatTrashDate = (stamp: string) => {
  // 2026-11-16T10-20-30-123Z → Date
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z",
  );
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
};

// -----------------------------------------------------------------------------
// panel
// -----------------------------------------------------------------------------

export const WorkspacePanel = ({ theme }: { theme: "light" | "dark" }) => {
  const info = useAtomValue(workspaceInfoAtom);
  const tree = useAtomValue(workspaceTreeAtom);
  const meta = useAtomValue(workspaceMetaAtom);
  const current = useAtomValue(currentPageAtom);
  const detached = useAtomValue(detachedAtom);
  const saveStatus = useAtomValue(saveStatusAtom);
  const saveError = useAtomValue(saveErrorAtom);
  const open = useAtomValue(workspacePanelOpenAtom);
  const excalidrawAPI = useExcalidrawAPI();

  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [query, setQuery] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [width, setWidth] = useState(loadWidth);
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckMeta | null>(null);
  const dark = theme === "dark";

  const closeMenu = useCallback(() => setMenu(null), []);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    }
  }, []);

  const toggleExpanded = useCallback((path: string, force?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const shouldOpen = force ?? !next.has(path);
      if (shouldOpen) {
        next.add(path);
      } else {
        next.delete(path);
      }
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);

  // reveal the open page in the tree
  useEffect(() => {
    if (!current) {
      return;
    }
    let folder = dirname(current);
    while (folder) {
      if (!expanded.has(folder)) {
        toggleExpanded(folder, true);
      }
      folder = dirname(folder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const refreshTrash = useCallback(async () => {
    try {
      setTrash((await workspaceApi.listTrash()).items);
    } catch {
      setTrash([]);
    }
  }, []);

  useEffect(() => {
    if (trashOpen) {
      refreshTrash();
    }
  }, [trashOpen, tree, refreshTrash]);

  // is the open page a deck? (debounced — onChange fires a lot)
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = "";
    const check = () => {
      timer = null;
      const next = getDeckMeta(excalidrawAPI.getSceneElements());
      const key = next ? JSON.stringify(next) : "";
      if (key !== last) {
        last = key;
        setDeck(next);
      }
    };
    check();
    const unsubscribe = excalidrawAPI.onChange(() => {
      if (!timer) {
        timer = setTimeout(check, 400);
      }
    });
    return () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [excalidrawAPI, current]);

  // actions -----------------------------------------------------------------

  const toast = (message: string) =>
    excalidrawAPI?.setToast({ message, closable: true, duration: 5000 });

  /** "New deck from pages…", with `initial` pages already picked */
  const openDeckPicker = (x: number, y: number, initial: string[] = []) => {
    const create = async (request: DeckRequest) => {
      const {
        path,
        deck: built,
        skipped,
      } = await createDeckPage({
        ...request,
        parent: dirname(request.sources[0].path),
      });
      if (path) {
        toast(
          `Deck "${basename(path)}": ${
            built.slideCount
          } slides from ${pageCount(request.sources.length)}${
            skipped ? ` (${skipped})` : ""
          }.`,
        );
      }
    };
    setMenu({
      x,
      y,
      content: (
        <DeckPicker
          pages={allNodes.filter((node) => node.type === "file")}
          initial={initial}
          onCreate={create}
          onClose={closeMenu}
        />
      ),
    });
  };

  const refreshCurrentDeck = () => {
    if (
      !excalidrawAPI ||
      !deck ||
      !window.confirm(
        `Rebuild this deck from its ${pageCount(
          deck.sources.length,
        )}, in its recorded order?\nChanges made inside the deck are replaced (⌘Z undoes).`,
      )
    ) {
      return;
    }
    run(async () => {
      const { deck: built, skipped } = await refreshDeck(excalidrawAPI);
      toast(
        `Deck rebuilt: ${built.slideCount} slides${
          skipped ? ` (${skipped})` : ""
        }.`,
      );
    });
  };

  const newPage = (parent = "") =>
    run(async () => {
      if (parent) {
        toggleExpanded(parent, true);
      }
      const path = await workspace.createPage(parent, "Untitled");
      if (path) {
        setRenaming(path);
      }
    });

  /** Word, Markdown, text or Excalidraw files → pages in `parent` */
  const importFiles = (files: File[], parent = "") =>
    run(async () => {
      if (!files.length) {
        return;
      }
      if (parent) {
        toggleExpanded(parent, true);
      }
      await importFilesAsPages(excalidrawAPI, files, parent);
    });

  const pickAndImport = (parent = "") =>
    pickFiles(PAGE_IMPORT_ACCEPT).then((files) => importFiles(files, parent));

  const newFolder = (parent = "") =>
    run(async () => {
      if (parent) {
        toggleExpanded(parent, true);
      }
      const path = await workspace.createFolder(parent, "New folder");
      setRenaming(path);
    });

  const commitRename = (node: TreeNode, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === node.name) {
      return;
    }
    run(async () => {
      const next = await workspace.rename(node.path, trimmed);
      if (node.type === "folder" && expanded.has(node.path)) {
        toggleExpanded(node.path, false);
        toggleExpanded(next, true);
      }
    });
  };

  const setIcon = (path: string, emoji: string | null) =>
    run(async () => {
      const icons = { ...meta.icons };
      if (emoji) {
        icons[path] = emoji;
      } else {
        delete icons[path];
      }
      await workspace.setMeta({ icons });
    });

  const toggleFavorite = (path: string) =>
    run(async () => {
      const favorites = meta.favorites.includes(path)
        ? meta.favorites.filter((p) => p !== path)
        : [...meta.favorites, path];
      await workspace.setMeta({ favorites });
    });

  const openIconPicker = (path: string, x: number, y: number) =>
    setMenu({
      x,
      y,
      content: (
        <EmojiPicker
          onPick={(emoji) => {
            setMenu(null);
            setIcon(path, emoji);
          }}
        />
      ),
    });

  const openNodeMenu = (node: TreeNode, x: number, y: number) => {
    const isFolder = node.type === "folder";
    const isFavorite = meta.favorites.includes(node.path);
    const items: MenuItem[] = [
      ...(isFolder
        ? ([
            { label: "New page inside", onSelect: () => newPage(node.path) },
            {
              label: "New folder inside",
              onSelect: () => newFolder(node.path),
            },
            {
              label: "Import into folder…",
              hint: "Word, Markdown",
              onSelect: () => pickAndImport(node.path),
            },
            "separator",
          ] as MenuItem[])
        : []),
      {
        label: "Rename",
        hint: "Double-click",
        onSelect: () => setRenaming(node.path),
      },
      { label: "Change icon", onSelect: () => openIconPicker(node.path, x, y) },
      {
        label: isFavorite ? "Remove from favorites" : "Add to favorites",
        onSelect: () => toggleFavorite(node.path),
      },
      ...(!isFolder
        ? ([
            {
              label: "Duplicate",
              onSelect: () => run(() => workspace.duplicate(node.path)),
            },
            {
              label: "New deck from pages…",
              onSelect: () => openDeckPicker(x, y, [node.path]),
            },
            ...(node.path === current && deck
              ? [
                  {
                    label: "Refresh deck from sources",
                    onSelect: refreshCurrentDeck,
                  },
                ]
              : []),
          ] as MenuItem[])
        : []),
      ...(dirname(node.path)
        ? ([
            {
              label: "Move to top level",
              onSelect: () => run(() => workspace.move(node.path, "")),
            },
          ] as MenuItem[])
        : []),
      "separator",
      {
        label: "Show in Finder",
        onSelect: () => run(() => workspaceApi.reveal(node.path)),
      },
      {
        label: "Copy file path",
        onSelect: () =>
          navigator.clipboard?.writeText(`${info?.root}/${node.path}`),
      },
      "separator",
      {
        label: "Move to trash",
        danger: true,
        onSelect: () => run(() => workspace.trash(node.path)),
      },
    ];
    setMenu({ x, y, content: <MenuList items={items} onClose={closeMenu} /> });
  };

  const openWorkspaceMenu = (x: number, y: number) => {
    const items: MenuItem[] = [
      { label: "New page", onSelect: () => newPage("") },
      { label: "New folder", onSelect: () => newFolder("") },
      {
        label: "New deck from pages…",
        hint: "Slides",
        onSelect: () => openDeckPicker(x, y),
      },
      {
        label: "Import as pages…",
        hint: "Word, Markdown",
        onSelect: () => pickAndImport(""),
      },
      "separator",
      {
        label: "Open folder in Finder",
        onSelect: () => run(() => workspaceApi.reveal()),
      },
      {
        label: "Copy folder path",
        onSelect: () => navigator.clipboard?.writeText(info?.root || ""),
      },
      {
        label: "Change workspace folder…",
        onSelect: () => {
          const next = window.prompt(
            "Absolute path of the folder to use as your workspace.\nTip: a folder inside Google Drive (My Drive) is backed up automatically.",
            info?.root || "",
          );
          if (next && next.trim() && next.trim() !== info?.root) {
            run(() => workspace.changeRoot(next.trim()));
          }
        },
      },
    ];
    setMenu({ x, y, content: <MenuList items={items} onClose={closeMenu} /> });
  };

  // drag & drop -----------------------------------------------------------

  const onDragStart = (event: React.DragEvent, node: TreeNode) => {
    event.dataTransfer.setData(DRAG_TYPE, node.path);
    event.dataTransfer.effectAllowed = "move";
  };

  const dropProps = (folderPath: string) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes(DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(folderPath);
      } else if (dragHasFiles(event.dataTransfer)) {
        // files from Finder / the desktop become pages here
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setDropTarget(folderPath);
      }
    },
    onDragLeave: () =>
      setDropTarget((target) => (target === folderPath ? null : target)),
    onDrop: (event: React.DragEvent) => {
      const from = event.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!from && event.dataTransfer.files.length) {
        event.preventDefault();
        event.stopPropagation();
        importFiles(Array.from(event.dataTransfer.files), folderPath);
        return;
      }
      if (!from || dirname(from) === folderPath || isInside(folderPath, from)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (folderPath) {
        toggleExpanded(folderPath, true);
      }
      run(() => workspace.move(from, folderPath));
    },
  });

  // resize ------------------------------------------------------------------

  const onResizeStart = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    const onMove = (e: PointerEvent) => {
      latest = Math.max(200, Math.min(480, startWidth + e.clientX - startX));
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        localStorage.setItem(WIDTH_KEY, String(latest));
      } catch {}
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // rendering ---------------------------------------------------------------

  const allNodes = useMemo(() => flatten(tree), [tree]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return null;
    }
    return allNodes.filter((node) => node.name.toLowerCase().includes(q));
  }, [allNodes, query]);

  const favoriteNodes = useMemo(
    () =>
      meta.favorites
        .map((path) => allNodes.find((n) => n.path === path))
        .filter((n): n is TreeNode => !!n),
    [meta.favorites, allNodes],
  );

  const renderIcon = (node: TreeNode) => {
    const emoji = meta.icons[node.path];
    return (
      <span
        className="ws-row__icon"
        role="button"
        title="Change icon"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openIconPicker(node.path, rect.left, rect.bottom + 4);
        }}
      >
        {emoji ? (
          <span className="ws-row__emoji">{emoji}</span>
        ) : node.type === "folder" ? (
          folderIcon
        ) : (
          pageIcon
        )}
      </span>
    );
  };

  const renderRow = (
    node: TreeNode,
    depth: number,
    opts: { flat?: boolean; showPath?: boolean } = {},
  ): React.ReactNode => {
    const isFolder = node.type === "folder";
    const isOpen = isFolder && expanded.has(node.path) && !opts.flat;
    const isActive = node.path === current;
    const key = `${opts.flat ? "flat:" : ""}${node.path}`;

    return (
      <React.Fragment key={key}>
        <div
          className={clsx("ws-row", {
            "is-active": isActive,
            "is-drop-target": isFolder && dropTarget === node.path,
          })}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={renaming !== node.path}
          onDragStart={(event) => onDragStart(event, node)}
          {...(opts.flat
            ? {}
            : dropProps(isFolder ? node.path : dirname(node.path)))}
          onClick={() => {
            if (isFolder) {
              toggleExpanded(node.path);
            } else {
              run(() => workspace.openPage(node.path));
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            setRenaming(node.path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openNodeMenu(node, event.clientX, event.clientY);
          }}
          title={node.path}
        >
          {isFolder && !opts.flat ? (
            <span
              className={clsx("ws-row__chevron", { "is-open": isOpen })}
              aria-hidden="true"
            >
              {chevronIcon}
            </span>
          ) : (
            <span className="ws-row__chevron-spacer" />
          )}
          {renderIcon(node)}
          {renaming === node.path ? (
            <input
              className="ws-row__rename"
              autoFocus
              defaultValue={node.name}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitRename(node, e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setRenaming(null);
                }
              }}
            />
          ) : (
            <span className="ws-row__name">
              {node.name}
              {opts.showPath && dirname(node.path) && (
                <span className="ws-row__path">{dirname(node.path)}</span>
              )}
            </span>
          )}
          <span className="ws-row__actions">
            <button
              className="ws-icon-btn"
              title="More"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                openNodeMenu(node, rect.left, rect.bottom + 4);
              }}
            >
              {dotsIcon}
            </button>
            {isFolder && (
              <button
                className="ws-icon-btn"
                title="New page inside"
                onClick={(event) => {
                  event.stopPropagation();
                  newPage(node.path);
                }}
              >
                {plusIcon}
              </button>
            )}
          </span>
        </div>
        {isOpen &&
          (node.children?.length ? (
            node.children.map((child) => renderRow(child, depth + 1))
          ) : (
            <div
              className="ws-empty-folder"
              style={{ paddingLeft: 6 + (depth + 1) * 14 + 22 }}
            >
              No pages inside
            </div>
          ))}
      </React.Fragment>
    );
  };

  if (!info) {
    return null;
  }

  const statusText =
    saveStatus === "saving"
      ? "Saving…"
      : saveStatus === "error"
      ? "Couldn't save"
      : detached
      ? "Not saved to workspace"
      : "Saved";

  return (
    <aside
      className={clsx("ws-panel", {
        "is-open": open,
        "ws-theme-dark": dark,
      })}
      style={{ ["--ws-width" as any]: `${width}px` }}
      aria-hidden={!open}
      // files dropped anywhere else on the panel become top-level pages
      // (and never make the browser navigate to the file)
      onDragOver={(event) => {
        if (dragHasFiles(event.dataTransfer)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (
          event.dataTransfer.files.length &&
          !event.dataTransfer.getData(DRAG_TYPE)
        ) {
          event.preventDefault();
          setDropTarget(null);
          importFiles(Array.from(event.dataTransfer.files), "");
        }
      }}
    >
      <div className="ws-panel__inner">
        <header className="ws-header">
          <button
            className="ws-header__title"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openWorkspaceMenu(rect.left, rect.bottom + 4);
            }}
            title={info.root}
          >
            <span className="ws-header__logo">
              {info.isGoogleDrive ? cloudIcon : folderIcon}
            </span>
            <span className="ws-header__name">
              {basename(info.root) || "Workspace"}
            </span>
            <span className="ws-header__caret">{chevronIcon}</span>
          </button>
          <button
            className="ws-icon-btn"
            title="Close sidebar (⌘\)"
            onClick={() => setWorkspacePanelOpen(false)}
          >
            {collapseIcon}
          </button>
        </header>

        <div className="ws-search">
          {searchIcon}
          <input
            type="search"
            placeholder="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && searchResults?.length) {
                const first = searchResults.find((n) => n.type === "file");
                if (first) {
                  run(() => workspace.openPage(first.path));
                }
              } else if (e.key === "Escape") {
                setQuery("");
              }
            }}
          />
        </div>

        <button className="ws-new-page" onClick={() => newPage("")}>
          {plusIcon}
          <span>New page</span>
        </button>

        <div className="ws-scroll">
          {detached && (
            <div className="ws-callout">
              <p>This drawing isn't saved in your workspace yet.</p>
              <button
                className="ws-callout__btn"
                onClick={() =>
                  run(async () => {
                    const name = window.prompt("Page name", "Untitled");
                    if (name !== null) {
                      await workspace.saveCanvasAsPage(
                        name.trim() || "Untitled",
                      );
                    }
                  })
                }
              >
                Save as page
              </button>
            </div>
          )}

          {deck && current && !detached && (
            <div className="ws-callout">
              <p>
                This page is a deck of {pageCount(deck.sources.length)}:{" "}
                {deck.sources.map((source) => source.name).join(", ")}.
              </p>
              <button className="ws-callout__btn" onClick={refreshCurrentDeck}>
                Refresh deck from sources
              </button>
            </div>
          )}

          {searchResults ? (
            <section className="ws-section">
              <div className="ws-section__title">
                <span>Results</span>
              </div>
              {searchResults.length ? (
                searchResults.map((node) =>
                  renderRow(node, 0, { flat: true, showPath: true }),
                )
              ) : (
                <div className="ws-muted">No pages match "{query}"</div>
              )}
            </section>
          ) : (
            <>
              {favoriteNodes.length > 0 && (
                <section className="ws-section">
                  <div className="ws-section__title">
                    <span>{starIcon} Favorites</span>
                  </div>
                  {favoriteNodes.map((node) =>
                    renderRow(node, 0, { flat: true }),
                  )}
                </section>
              )}

              <section
                className={clsx("ws-section ws-section--pages", {
                  "is-drop-target": dropTarget === "",
                })}
                {...dropProps("")}
              >
                <div className="ws-section__title">
                  <span>Pages</span>
                  <span className="ws-section__actions">
                    <button
                      className="ws-icon-btn"
                      title="New deck from pages…"
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        openDeckPicker(rect.left, rect.bottom + 4);
                      }}
                    >
                      {deckIcon}
                    </button>
                    <button
                      className="ws-icon-btn"
                      title="New folder"
                      onClick={() => newFolder("")}
                    >
                      {folderIcon}
                    </button>
                    <button
                      className="ws-icon-btn"
                      title="New page"
                      onClick={() => newPage("")}
                    >
                      {plusIcon}
                    </button>
                  </span>
                </div>
                {tree.length ? (
                  tree.map((node) => renderRow(node, 0))
                ) : (
                  <div className="ws-muted">
                    No pages yet — create one, or drop Word / Markdown files
                    here.
                  </div>
                )}
              </section>
            </>
          )}

          <section className="ws-section">
            <button
              className="ws-section__title ws-section__title--button"
              onClick={() => setTrashOpen((v) => !v)}
            >
              <span>{trashIcon} Trash</span>
              <span
                className={clsx("ws-row__chevron", { "is-open": trashOpen })}
              >
                {chevronIcon}
              </span>
            </button>
            {trashOpen &&
              (trash.length ? (
                trash.map((item) => (
                  <div
                    key={item.id}
                    className="ws-trash-row"
                    title={item.originalPath}
                  >
                    <span className="ws-row__icon">
                      {item.type === "folder" ? folderIcon : pageIcon}
                    </span>
                    <span className="ws-row__name">
                      {item.name}
                      <span className="ws-row__path">
                        {formatTrashDate(item.trashedAt)}
                      </span>
                    </span>
                    <button
                      className="ws-text-btn"
                      onClick={() =>
                        run(async () => {
                          const { path } = await workspaceApi.restore(item.id);
                          await workspace.refreshTree();
                          await refreshTrash();
                          if (item.type === "file") {
                            await workspace.openPage(path);
                          }
                        })
                      }
                    >
                      Restore
                    </button>
                    <button
                      className="ws-text-btn is-danger"
                      title="Delete forever"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete "${item.name}" forever? This can't be undone.`,
                          )
                        ) {
                          run(async () => {
                            await workspaceApi.deleteForever(item.id);
                            await refreshTrash();
                          });
                        }
                      }}
                    >
                      {trashIcon}
                    </button>
                  </div>
                ))
              ) : (
                <div className="ws-muted">Trash is empty</div>
              ))}
          </section>
        </div>

        {error && (
          <div className="ws-error" role="alert">
            <span>{error}</span>
            <button className="ws-text-btn" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <footer
          className="ws-footer"
          title={saveError || info.root}
          onClick={() => run(() => workspaceApi.reveal())}
        >
          <span
            className={clsx("ws-status-dot", {
              "is-saving": saveStatus === "saving",
              "is-error": saveStatus === "error",
              "is-detached": detached,
            })}
          />
          <span className="ws-footer__status">{statusText}</span>
          <span className="ws-footer__label">{info.label}</span>
        </footer>
      </div>
      <div className="ws-resize" onPointerDown={onResizeStart} />
      {menu && <Popover state={menu} onClose={closeMenu} dark={dark} />}
    </aside>
  );
};

/** small button shown in the editor's top-left corner */
export const WorkspaceToggleButton = () => {
  const open = useAtomValue(workspacePanelOpenAtom);
  const info = useAtomValue(workspaceInfoAtom);
  const current = useAtomValue(currentPageAtom);
  if (!info) {
    return null;
  }
  return (
    <div className="ws-toggle">
      <button
        className="ws-toggle__btn"
        title={`${open ? "Hide" : "Show"} pages (⌘\\)`}
        aria-pressed={open}
        onClick={() => setWorkspacePanelOpen(!open)}
      >
        {sidebarToggleIcon}
      </button>
      {!open && current && (
        <span className="ws-toggle__page" title={current}>
          {basename(current)}
        </span>
      )}
    </div>
  );
};
