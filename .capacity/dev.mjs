#!/usr/bin/env node
// .capacity/dev.mjs: the dev command Capacity Desktop runs for this project
// (`.capacity/runtime.json`). It starts what upstream's `yarn start:server-dev`
// starts, the sync server in development mode on ACTUAL_PORT (5006) proxying
// the web client's Vite dev server on 3001, with three things the desktop needs:
//
// 1. `.env` at the project root is loaded first, so the ACTUAL_* variables
//    documented at https://actualbudget.org/docs/config/ reach the server. The
//    server reads only its environment and config.json, never a .env file. A
//    relative ACTUAL_DATA_DIR is taken from the project root.
// 2. No browser is opened (BROWSER=none), and any http://localhost:<port> the
//    children print (Vite's own "Local: http://localhost:3001/") loses its
//    scheme. The desktop opens the FIRST such URL this process prints, and the
//    client alone, without the server in front of it, has no server to talk to.
// 3. One "ready" line with the server's URL is printed once the server answers
//    /health, the proxied client answers / and the loot-core worker bundle is
//    served. Before that the preview would show a proxy error or a page whose
//    backend worker fails to load.
//
// Both children run in their own process groups and are stopped together on
// SIGTERM, SIGINT or SIGHUP (how the desktop stops an app) and when either of
// them exits on its own.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.ACTUAL_DATA_DIR && !path.isAbsolute(process.env.ACTUAL_DATA_DIR)) {
  process.env.ACTUAL_DATA_DIR = path.resolve(root, process.env.ACTUAL_DATA_DIR);
}

const port = Number(process.env.ACTUAL_PORT || 5006);
const readyUrl = `http://localhost:${port}`;
const probeBase = `http://127.0.0.1:${port}`;
const isWindows = process.platform === "win32";

// Any loopback URL a child prints, scheme dropped so the desktop never opens it.
const LOOPBACK_URL = /https?:\/\/(localhost|127\.0\.0\.1):\d+/gi;

const children = [];
let shuttingDown = false;

function start(name, args, extraEnv) {
  const child = spawn("yarn", args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
    shell: isWindows,
  });
  const forward = (stream, out) => {
    createInterface({ input: stream }).on("line", (line) => {
      out.write(`${line.replace(LOOPBACK_URL, (url) => url.replace(/^https?:\/\//, ""))}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[capacity] ${name} exited (${signal ?? `code ${code}`}); stopping the rest`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function signalAll(signal) {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (isWindows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  }
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  signalAll("SIGTERM");
  const deadline = setTimeout(() => {
    signalAll("SIGKILL");
    process.exit(exitCode);
  }, 8000);
  deadline.unref();
  const pending = children.filter((c) => c.exitCode === null && c.signalCode === null);
  let left = pending.length;
  if (left === 0) process.exit(exitCode);
  for (const child of pending) {
    child.once("exit", () => {
      if (--left === 0) process.exit(exitCode);
    });
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(0));
}

async function answers(pathname, contentType) {
  try {
    const res = await fetch(`${probeBase}${pathname}`, { signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    if (!res.ok) return false;
    return !contentType || (res.headers.get("content-type") ?? "").includes(contentType);
  } catch {
    return false;
  }
}

async function waitUntilReady() {
  const startedAt = Date.now();
  let warned = false;
  for (;;) {
    if (shuttingDown) return;
    if (
      (await answers("/health", "application/json")) &&
      (await answers("/", "text/html")) &&
      (await answers("/kcab/kcab.worker.dev.js", "javascript"))
    ) {
      console.log(`\nActual is ready at ${readyUrl}\n`);
      return;
    }
    if (!warned && Date.now() - startedAt > 120_000) {
      warned = true;
      console.log(`[capacity] still waiting for the server on port ${port}, the client on 3001 and the loot-core worker bundle`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

console.log(`Starting Actual: sync server on port ${port} (development mode), web client on 3001 behind it`);
start("sync server", ["workspace", "@actual-app/sync-server", "start-monitor"], {
  NODE_ENV: "development",
  ACTUAL_PORT: String(port),
});
start("web client", ["start:browser"], { BROWSER: "none" });
void waitUntilReady();
