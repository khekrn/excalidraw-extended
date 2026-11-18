/**
 * Runs a canvas prompt through the local Claude Code CLI (`claude -p`), using
 * whatever account Claude Code is logged into — no API key needed.
 *
 * Claude answers with structured JSON (`message` + `ops`), which the app
 * applies to the canvas as one undoable change.
 */
import { spawn } from "child_process";
import os from "os";

const MODELS = new Set(["sonnet", "opus", "haiku"]);
const TIMEOUT_MS = 4 * 60 * 1000;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          elements: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              additionalProperties: true,
            },
          },
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["op"],
      },
    },
  },
  required: ["message", "ops"],
};

const SYSTEM_PROMPT = `You are the drawing assistant built into the user's Excalidraw whiteboard. The user types a request; you change the canvas by returning operations. They are applied immediately, as one change the user can undo with Cmd+Z.

Return JSON: {"message": string, "ops": Op[]}
- message: one or two short sentences saying what you did, or answering the question. Plain text, no markdown.
- ops: applied in order. Use [] when the request needs no canvas change.

Operations:
1. {"op":"add","elements":[Element, ...]} — create elements.
2. {"op":"update","updates":[{"id":"...", <changed fields>}]} — change existing elements. Fields: x, y, width, height, angle (radians), strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, text (a text element's text, or the label of a shape/arrow — pass the shape's id), fontSize, name (frames), link.
3. {"op":"delete","ids":["..."]} — delete elements. A shape's label and a frame's contents go with it.

Element fields (for "add"):
- Always: "id" (a short unique id you invent, e.g. "db-box"; must not clash with existing ids), "type", "x", "y" (top-left in scene px; y grows downward).
- Optional styling: width, height, strokeColor, backgroundColor, fillStyle ("solid" | "hachure" | "cross-hatch"), strokeWidth (1 | 2 | 4), strokeStyle ("solid" | "dashed" | "dotted"), roughness (0 clean, 1 sketchy [default], 2 very sketchy), opacity (0-100), roundness ({"type":3} rounds rectangle corners).
- "rectangle" | "ellipse" | "diamond": optional "label": {"text": "...", "fontSize": 20}. Put text inside shapes with a label rather than a separate text element. Size shapes to fit their label (about 11px per character at fontSize 20, plus 40px padding; at least 140x60).
- "text": "text" (use \\n for new lines), "fontSize" (16 small, 20 body, 28 heading, 48 slide title), "textAlign" ("left" | "center" | "right"). Width/height are measured automatically.
- "arrow" | "line": "x","y" = start point, "points": [[0,0],[dx,dy], ...] relative to x,y. Connect an arrow to shapes with "start": {"id": "<id>"} and "end": {"id": "<id>"} (existing ids, or ids added in the same op) — its ends then snap to the shapes, so x/y/points only need to be roughly right. Optional "label": {"text": "..."}, "startArrowhead"/"endArrowhead" ("arrow" | "triangle" | "dot" | "bar" | null).
- "stickynote": a filled note — "label": {"text": "..."}, "backgroundColor", "width", "height".
- "frame": a slide or section — "name", "x", "y", "width", "height", "children": [ids of elements added in the same op that belong inside it].

Slides: the presentation is the list of frames, in the order given in the scene context. A new slide is a 1280x720 frame placed to the right of the last slide with a 160px gap (same y), or in the viewport if there are none. Inside a slide put a title text (fontSize 48) 80px from the frame's top-left corner, the content below it, everything within the frame bounds, and list every element of the slide in the frame's "children". For a multi-slide deck, add each slide in its own "add" op.

Layout:
- Put new content in the visible viewport (from the scene context) unless it extends existing content. Never overlap existing elements unless asked.
- Snap positions and sizes to multiples of 20; keep even gaps (40-80px); flow top-to-bottom or left-to-right; align centers.
- Palette — strokes: "#1e1e1e" (default), "#e03131" red, "#2f9e44" green, "#1971c2" blue, "#f08c00" orange, "#9c36b5" violet. Fills: "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#d0bfff", "#eebefa", "#e9ecef", "transparent". For diagrams use fillStyle "solid" with light fills.
- "this"/"these"/"selected" means the selected elements (selectedIds in the scene context).
- To change existing elements use "update" rather than delete + add, so ids, arrows and history are kept.

The scene context is JSON: "viewport" (visible area in scene coords), "selectedIds", "elements" (id, type, x, y, w, h, text or label, colors, frameId, start/end for arrows; may be truncated — see "omitted"), "slides" (frames in presentation order).`;

export type ClaudePromptResult = {
  message: string;
  ops: unknown[];
  durationMs: number;
  model: string;
};

export const runClaudePrompt = ({
  prompt,
  context,
  history = [],
  model = "sonnet",
  signal,
}: {
  prompt: string;
  context: string;
  history?: { role: "user" | "assistant"; text: string }[];
  model?: string;
  signal?: AbortSignal;
}): Promise<ClaudePromptResult> => {
  if (!prompt?.trim()) {
    return Promise.reject(new Error("Empty prompt"));
  }
  const modelAlias = MODELS.has(model) ? model : "sonnet";

  const conversation = history
    .slice(-8)
    .map(
      (turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`,
    )
    .join("\n");

  const input = [
    "<scene_context>",
    context,
    "</scene_context>",
    conversation &&
      `<earlier_conversation>\n${conversation}\n</earlier_conversation>`,
    `<request>\n${prompt.trim()}\n</request>`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const env = { ...process.env };
  // don't let a parent Claude Code session's env leak into the child
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(OUTPUT_SCHEMA),
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--model",
    modelAlias,
    "--system-prompt",
    SYSTEM_PROMPT,
  ];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.env.EXCALIDRAW_CLAUDE_BIN || "claude", args, {
      // a neutral cwd so no project CLAUDE.md/settings get pulled in
      cwd: os.tmpdir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude took too long (over 4 minutes)."));
    }, TIMEOUT_MS);

    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(
          new Error(
            (stderr || stdout || `claude exited with code ${code}`).trim(),
          ),
        );
      }
      if (parsed.is_error) {
        return reject(
          new Error(
            String(
              parsed.result || parsed.subtype || "Claude returned an error",
            ),
          ),
        );
      }
      let output = parsed.structured_output;
      if (!output && typeof parsed.result === "string") {
        try {
          output = JSON.parse(parsed.result);
        } catch {
          output = { message: parsed.result, ops: [] };
        }
      }
      resolve({
        message: String(output?.message ?? ""),
        ops: Array.isArray(output?.ops) ? output.ops : [],
        durationMs: Date.now() - startedAt,
        model: modelAlias,
      });
    });

    child.stdin.end(input);
  });
};
