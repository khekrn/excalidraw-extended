/**
 * Dev convenience: starts the Cloudflare collab worker (`collab-worker/`,
 * `wrangler dev` on :8787) alongside the Vite dev server, so Share / live
 * collaboration work with just `yarn start`.
 *
 * Skipped when something already listens on the port (e.g. you run
 * `npx wrangler dev` yourself), when the worker's dependencies aren't
 * installed, or with EXCALIDRAW_START_COLLAB_WORKER=false.
 */
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";

import type { ChildProcess } from "child_process";
import type { Plugin } from "vite";

const PORT = 8787;

// survives Vite's config-change restarts (which re-import this module)
const state = globalThis as typeof globalThis & {
  __excalidrawCollabWorker?: ChildProcess | null;
};

const isPortInUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });

const start = async (workerDir: string) => {
  if (state.__excalidrawCollabWorker || process.env.CI) {
    return;
  }
  if (process.env.EXCALIDRAW_START_COLLAB_WORKER === "false") {
    return;
  }
  const wrangler = path.join(workerDir, "node_modules", ".bin", "wrangler");
  if (!fs.existsSync(wrangler)) {
    console.warn(
      `\n  ⚠ Live collaboration needs the collab worker. Install it once with:\n    cd collab-worker && npm install\n`,
    );
    return;
  }
  if (await isPortInUse(PORT)) {
    return; // already running (e.g. started by hand)
  }

  const child = spawn(wrangler, ["dev", "--port", String(PORT)], {
    cwd: workerDir,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.__excalidrawCollabWorker = child;

  let announced = false;
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    if (!announced && /Ready on|localhost:8787/.test(text)) {
      announced = true;
      // eslint-disable-next-line no-console
      console.log(
        `  🤝 Collab worker (Durable Objects, local): http://localhost:${PORT}`,
      );
    }
    if (/✘|\[ERROR\]/.test(text)) {
      console.error(`[collab-worker] ${text.trim()}`);
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.on("error", (error) => {
    console.error("[collab-worker] failed to start", error);
    state.__excalidrawCollabWorker = null;
  });
  child.on("exit", (code) => {
    if (state.__excalidrawCollabWorker === child) {
      state.__excalidrawCollabWorker = null;
    }
    if (code && code !== 0) {
      console.error(`[collab-worker] exited with code ${code}`);
    }
  });

  const stop = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
};

export const collabWorkerDevPlugin = (workerDir: string): Plugin => ({
  name: "excalidraw-collab-worker-dev",
  apply: "serve",
  configureServer() {
    start(workerDir).catch((error) =>
      console.error("[collab-worker] couldn't start", error),
    );
  },
});
