import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useExcalidrawAPI } from "@excalidraw/excalidraw";

import { atom, useAtom, useAtomValue } from "../app-jotai";
import { workspaceApi } from "../workspace/api";
import { currentPageAtom, workspaceInfoAtom } from "../workspace/workspace";

import { applyOps, describeScene } from "./canvasOps";

import "./ClaudePanel.scss";

import type { ApplySummary } from "./canvasOps";

type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      summary?: ApplySummary;
      durationMs?: number;
      error?: boolean;
    };

const MODELS = [
  { id: "sonnet", label: "Sonnet", hint: "fast" },
  { id: "opus", label: "Opus", hint: "best" },
  { id: "haiku", label: "Haiku", hint: "fastest" },
];

const MODEL_KEY = "excalidraw-claude-model";

/** chat history per page (kept for the session) */
const chatsAtom = atom<Record<string, ChatMessage[]>>({});

const EXAMPLES = [
  "Draw a flowchart of a user signing up and verifying their email",
  "Make a 4-slide deck introducing our product roadmap",
  "Color the selected shapes green and align them in a row",
  "Add a title above this diagram",
];

const summaryText = (summary: ApplySummary) => {
  const parts = [
    summary.added && `+${summary.added} added`,
    summary.updated && `${summary.updated} updated`,
    summary.deleted && `${summary.deleted} deleted`,
  ].filter(Boolean);
  return parts.join(" · ");
};

const ClaudeMark = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 2.5l1.6 6.1 6.1-1.9-4.4 4.6 4.4 4.6-6.1-1.9L12 20.1l-1.6-6.1-6.1 1.9 4.4-4.6-4.4-4.6 6.1 1.9z"
    />
  </svg>
);

export const ClaudePanel = () => {
  const api = useExcalidrawAPI();
  const info = useAtomValue(workspaceInfoAtom);
  const page = useAtomValue(currentPageAtom);
  const [chats, setChats] = useAtom(chatsAtom);
  const chatKey = page || "__unsaved__";
  const messages = chats[chatKey] || [];

  const [input, setInput] = useState("");
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(MODEL_KEY) || "sonnet";
    } catch {
      return "sonnet";
    }
  });
  const [running, setRunning] = useState<{ startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [selectedCount, setSelectedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!api) {
      return;
    }
    const update = () => {
      const ids = api.getAppState().selectedElementIds;
      setSelectedCount(Object.keys(ids).filter((id) => ids[id]).length);
    };
    update();
    return api.onChange(update);
  }, [api]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - running.startedAt) / 1000)),
      500,
    );
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, running]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const push = (key: string, message: ChatMessage) =>
    setChats((prev) => ({ ...prev, [key]: [...(prev[key] || []), message] }));

  const send = async (text = input) => {
    const prompt = text.trim();
    if (!prompt || !api || running) {
      return;
    }
    const key = chatKey;
    const history = messages
      .filter((m) => !(m.role === "assistant" && m.error))
      .map((m) => ({ role: m.role, text: m.text }));
    push(key, { role: "user", text: prompt });
    setInput("");
    setRunning({ startedAt: Date.now() });
    setElapsed(0);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await workspaceApi.ai(
        { prompt, context: describeScene(api), history, model },
        controller.signal,
      );
      const summary = applyOps(api, result.ops);
      push(key, {
        role: "assistant",
        text: result.message || (result.ops.length ? "Done." : "No changes."),
        summary,
        durationMs: result.durationMs,
      });
    } catch (error: any) {
      push(key, {
        role: "assistant",
        text:
          error?.name === "AbortError"
            ? "Stopped."
            : error?.message || "Something went wrong.",
        error: true,
      });
    } finally {
      abortRef.current = null;
      setRunning(null);
      inputRef.current?.focus();
    }
  };

  const available = !!info?.ai.available;

  return (
    <div className="claude-panel">
      <div className="claude-panel__header">
        <span className="claude-panel__title">
          <span className="claude-panel__mark">
            <ClaudeMark />
          </span>
          Claude
        </span>
        <div className="claude-panel__header-actions">
          <select
            className="claude-panel__model"
            value={model}
            title="Model"
            onChange={(e) => {
              setModel(e.target.value);
              try {
                localStorage.setItem(MODEL_KEY, e.target.value);
              } catch {}
            }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.hint})
              </option>
            ))}
          </select>
          {messages.length > 0 && (
            <button
              className="claude-panel__clear"
              title="Clear conversation"
              onClick={() => setChats((prev) => ({ ...prev, [chatKey]: [] }))}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="claude-panel__messages" ref={listRef}>
        {!available ? (
          <div className="claude-panel__notice">
            {info ? (
              <>
                <strong>Claude Code CLI not found.</strong> Install Claude Code
                and log in (<code>claude</code> in a terminal), then restart{" "}
                <code>yarn start</code>.
              </>
            ) : (
              <>
                Claude prompts need the local workspace server — run the app
                with <code>yarn start</code> on this computer.
              </>
            )}
          </div>
        ) : messages.length === 0 ? (
          <div className="claude-panel__empty">
            <p>
              Describe what to draw or change. Claude edits this page directly —{" "}
              <kbd>⌘Z</kbd> undoes it.
            </p>
            <div className="claude-panel__examples">
              {EXAMPLES.map((example) => (
                <button key={example} onClick={() => send(example)}>
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, i) => (
            <div
              key={i}
              className={clsx("claude-msg", `claude-msg--${message.role}`, {
                "is-error": message.role === "assistant" && message.error,
              })}
            >
              <div className="claude-msg__text">{message.text}</div>
              {message.role === "assistant" && message.summary && (
                <div className="claude-msg__meta">
                  {summaryText(message.summary) || "No canvas changes"}
                  {message.durationMs
                    ? ` · ${(message.durationMs / 1000).toFixed(1)}s`
                    : ""}
                  {message.summary.errors.length > 0 && (
                    <span
                      className="claude-msg__warn"
                      title={message.summary.errors.join("\n")}
                    >
                      {" "}
                      · {message.summary.errors.length} skipped
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {running && (
          <div className="claude-msg claude-msg--assistant claude-msg--pending">
            <span className="claude-dots">
              <i />
              <i />
              <i />
            </span>
            <span>Working… {elapsed}s</span>
          </div>
        )}
      </div>

      <div className="claude-panel__composer">
        <div className="claude-panel__context">
          {selectedCount
            ? `${selectedCount} selected element${selectedCount > 1 ? "s" : ""}`
            : "Whole page"}
          {page ? "" : " · unsaved drawing"}
        </div>
        <textarea
          ref={inputRef}
          value={input}
          disabled={!available}
          rows={3}
          placeholder={
            selectedCount
              ? "What should Claude do with the selection?"
              : "Ask Claude to draw or change something…"
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="claude-panel__composer-row">
          <span className="claude-panel__hint">
            Enter to send · Shift+Enter for a new line
          </span>
          {running ? (
            <button
              className="claude-panel__send is-stop"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          ) : (
            <button
              className="claude-panel__send"
              disabled={!available || !input.trim()}
              onClick={() => send()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
