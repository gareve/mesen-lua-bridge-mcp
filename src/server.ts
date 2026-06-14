#!/usr/bin/env node
/**
 * Mesen 2 Lua MCP server.
 *
 * Exposes a single tool, `execute_lua`, that ships arbitrary Lua source to a
 * companion bridge script (`lua/mesen_bridge.lua`) running inside Mesen via
 * file-based polling under `/tmp/mesen-mcp/<pid>/`.
 *
 * Transport rationale (vs sockets): no listener accept() limit, no permission
 * for "Allow Network Access" required, survives MCP-server / Mesen / Claude
 * restarts in any order, inspectable with `cat`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

// Both sides must agree on a single path. On POSIX we hardcode /tmp because
// macOS GUI apps (Mesen) and CLI children (this server) often have different
// $TMPDIR values, which would split the rendezvous. On Windows there is no
// universal equivalent, so use os.tmpdir() (resolves %TEMP%/%TMP%).
const BRIDGE_ROOT  = process.platform === "win32"
  ? path.join(os.tmpdir(), "mesen-mcp")
  : "/tmp/mesen-mcp";
const SESSION_DIR       = path.join(BRIDGE_ROOT, String(process.pid));
const ACTIVE_PTR        = path.join(BRIDGE_ROOT, "active");
const ERROR_COUNT_FILE  = path.join(BRIDGE_ROOT, "error_count.txt");
const ALIVE_FILE        = path.join(SESSION_DIR, "alive");
const EPOCH_FILE        = path.join(SESSION_DIR, "epoch");
const REQUEST_FILE      = path.join(SESSION_DIR, "request.lua");
const RESPONSE_FILE     = path.join(SESSION_DIR, "response.txt");

const STALE_DIR_MS       = 60_000;
const HEARTBEAT_MS       = 1_000;
const POLL_INTERVAL_MS   = 25;
const DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(target: string, content: string | Buffer): void {
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function safeUnlink(target: string): void {
  try { fs.unlinkSync(target); } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Promise-chain mutex so concurrent tool calls serialize on the bridge.
let mutexChain: Promise<unknown> = Promise.resolve();
function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutexChain.then(() => fn());
  mutexChain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Stale dir sweep + lifecycle
// ---------------------------------------------------------------------------

function sweepStaleDirs(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(BRIDGE_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(BRIDGE_ROOT, entry.name);
    if (dirPath === SESSION_DIR) continue;
    const aliveFile = path.join(dirPath, "alive");
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(aliveFile).mtimeMs; } catch { /* missing → stale */ }
    if (now - mtimeMs > STALE_DIR_MS) {
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function setupSession(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(ALIVE_FILE, "");
  sweepStaleDirs();
  // Atomically publish ourselves as the active session.
  atomicWrite(ACTIVE_PTR, SESSION_DIR);

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(ALIVE_FILE, now, now);
    } catch { /* ignore — dir may have been wiped externally; will be recreated on next request */ }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const cleanup = () => {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("exit", cleanup);
  process.on("SIGINT",  () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

interface BridgeFrame {
  seq:     string;
  status:  "OK" | "ERR" | string;
  payload: string;
}

function parseFrame(raw: string): BridgeFrame | null {
  // Format:
  //   SEQ:<n>\n
  //   <STATUS>\n
  //   LEN <bytes>\n
  //   <bytes of payload>\n
  const seqMatch = raw.match(/^SEQ:(\S+)\n/);
  if (!seqMatch) return null;
  const afterSeq = raw.slice(seqMatch[0].length);

  const nlStatus = afterSeq.indexOf("\n");
  if (nlStatus < 0) return null;
  const status = afterSeq.slice(0, nlStatus);
  const afterStatus = afterSeq.slice(nlStatus + 1);

  const lenMatch = afterStatus.match(/^LEN (\d+)\n/);
  if (!lenMatch) return null;
  const len = Number(lenMatch[1]);
  const body = afterStatus.slice(lenMatch[0].length, lenMatch[0].length + len);

  return { seq: seqMatch[1], status, payload: body };
}

function readBridgeErrorCount(): number {
  try {
    const raw = fs.readFileSync(ERROR_COUNT_FILE, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function epochInfo(): string {
  try {
    const epoch = fs.readFileSync(EPOCH_FILE, "utf8").trim();
    if (!epoch) return "epoch file empty";
    const ts = Number(epoch);
    if (!Number.isFinite(ts)) return `epoch file present but unreadable (${epoch})`;
    const ageS = Math.floor(Date.now() / 1000) - ts;
    return `bridge script announced itself ${ageS}s ago (epoch=${epoch})`;
  } catch {
    return "no epoch file — bridge script has not bound to this MCP session";
  }
}

function timeoutDiagnostic(timeoutMs: number): string {
  return [
    `timeout: no response from Mesen Lua bridge after ${timeoutMs}ms`,
    `bridge state: ${epochInfo()}`,
    "checklist:",
    "  - Mesen 2 is running and a SNES ROM is loaded",
    "  - the bridge script (lua/mesen_bridge.lua) is loaded and running in Tools → Script Window",
    "  - Mesen → Tools → Script Window → Settings → 'Allow access to I/O and OS functions' is enabled",
    "  - Mesen → Tools → Script Window → Settings → 'Script timeout' is high enough (default 1s; recommend 10s)",
    "  - Mesen window is not paused (and PauseWhenInBackground is off if running minimized)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Bridge interaction
// ---------------------------------------------------------------------------

let nextSeq = 1;

function sanitizeDescription(desc: string | undefined): string {
  if (!desc) return "";
  // The DESC line is single-line in the wire format. Collapse any newlines /
  // carriage returns to spaces so we never break framing.
  return desc.replace(/[\r\n]+/g, " ").trim();
}

function ensureActive(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  if (!fs.existsSync(ALIVE_FILE)) {
    fs.writeFileSync(ALIVE_FILE, "");
  }
  let pointsToUs = false;
  try {
    pointsToUs = fs.readFileSync(ACTIVE_PTR, "utf8").trim() === SESSION_DIR;
  } catch { /* missing → reclaim */ }
  if (!pointsToUs) {
    atomicWrite(ACTIVE_PTR, SESSION_DIR);
  }
}

async function executeLua(code: string, timeoutMs: number, description: string): Promise<string> {
  return withMutex(async () => {
    // Reclaim the active pointer in case another MCP server stole it
    // (e.g. a stale instance briefly came up to test, or two servers exist).
    ensureActive();

    // Drop anything left over from a previous timed-out call.
    safeUnlink(REQUEST_FILE);
    safeUnlink(RESPONSE_FILE);

    const seq = String(nextSeq++);
    atomicWrite(REQUEST_FILE, `SEQ:${seq}\nDESC:${description}\n${code}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let raw: string | null = null;
      try {
        raw = fs.readFileSync(RESPONSE_FILE, "utf8");
      } catch { /* not yet */ }

      if (raw !== null) {
        const frame = parseFrame(raw);
        safeUnlink(RESPONSE_FILE);
        if (!frame) {
          throw new Error(`malformed response from Mesen Lua bridge:\n${raw}`);
        }
        if (frame.seq !== seq) {
          // Stale response from a previous timed-out call. Discard and keep polling.
          continue;
        }
        if (frame.status === "OK")  return frame.payload;
        if (frame.status === "ERR") throw new Error(`Error from Mesen Lua:\n${frame.payload}`);
        throw new Error(`Unexpected response status "${frame.status}":\n${frame.payload}`);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    // Best-effort: clear the request file so it doesn't poison the next call.
    safeUnlink(REQUEST_FILE);
    throw new Error(timeoutDiagnostic(timeoutMs));
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Run arbitrary Lua code inside the running Mesen 2 emulator and return the result.

How it works: the code is delivered to a Lua bridge script running in Mesen's Script Window via a per-PID directory under /tmp/mesen-mcp/. The bridge evaluates the code and writes a response file the server polls for. Single in-flight request at a time; concurrent calls serialize.

Eval semantics (REPL-style):
  - First, the code is wrapped in \`return (...)\` so bare expressions auto-return — e.g. \`emu.read(0x7E0000)\` returns the byte directly, no \`return\` keyword needed.
  - If that fails to parse, the code runs as a statement block — e.g. \`local x = emu.read(0x7E0000); return x * 2\` works too.
  - Multiple return values are joined with tab characters.
  - On Lua error, the response includes the full stack traceback.

Common Mesen 2 API entry points (full reference: https://www.mesen.ca/docs/apireference.html):
  - emu.read(addr, memType, [signed])     read 1 byte. memType is REQUIRED.
  - emu.read16/read32(addr, memType, [signed])
  - emu.write(addr, value, memType)       write 1 byte
  - emu.getState()                        table of CPU/PPU registers and timing
  - emu.getRomInfo()                      ROM header / file path / format
  - emu.log(msg)                          append to Mesen's script console
  - emu.addEventCallback(fn, type, label)        hook events. Pass a short label string as the third argument so the bridge tracks the callback — e.g. emu.addEventCallback(fn, emu.eventType.endFrame, "frame counter"). Use the clear_callbacks tool to remove by label. WARNING: without a label, callbacks accumulate across sessions and cannot be selectively cleared.

SNES memType values (use as the second arg to read/write):
  - emu.memType.snesMemory       CPU bus — addresses look like $7E0000 (WRAM), $00:8000 (ROM), etc.
  - emu.memType.snesWorkRam      direct WRAM, 0x00000-0x1FFFF (128KB)
  - emu.memType.snesPrgRom       cartridge ROM
  - emu.memType.snesSaveRam      SRAM
  - emu.memType.snesVideoRam     VRAM
  - emu.memType.snesSpriteRam    OAM
  - emu.memType.snesCgRam        palette
  - emu.memType.snesRegister     hardware registers ($2100-, $4000-)

Example calls:
  - emu.read(0x7E0000, emu.memType.snesMemory)         byte at $7E0000 via CPU bus
  - emu.read(0x0000, emu.memType.snesWorkRam)          first byte of WRAM directly
  - emu.read16(0x7E0010, emu.memType.snesMemory)       16-bit little-endian read

Prerequisites (one-time setup, see project README):
  - Mesen 2 running with a SNES ROM loaded
  - lua/mesen_bridge.lua loaded via Tools → Script Window
  - "Allow access to I/O and OS functions" enabled in Script Window settings
  - "Script timeout" raised from the 1s default to ~10s

Errors:
  - On Lua error inside the snippet: returns a text result starting "Error from Mesen Lua:" with traceback.
  - On no response within timeoutMs (default 5000): a diagnostic listing common causes.

REQUIRED parameter \`description\`: a short human-readable label for the call (e.g. "reading WRAM 0x7E0000", "writing 0xFF to OAM byte 4"). Logged to the Script Window's bottom log pane via emu.log so you can audit what was run during reverse engineering. Debugging-only; does not affect execution. Calls without it are rejected.`;

const server = new McpServer({
  name:    "mesen-lua-bridge-mcp",
  version: "0.1.0",
});

server.tool(
  "execute_lua",
  TOOL_DESCRIPTION,
  {
    code: z.string().describe("The Lua source to execute inside Mesen."),
    description: z.string().min(1)
      .describe("REQUIRED. Short human-readable label for this call (e.g. \"reading WRAM 0x7E0000\"). Logged to the Script Window's bottom pane via emu.log so you can audit what was run during reverse engineering. Single line; newlines are collapsed to spaces."),
    timeoutMs: z.number().int().positive().optional()
      .describe(`How long to wait for Mesen's response, in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
  },
  async ({ code, description, timeoutMs }) => {
    const sanitized = sanitizeDescription(description);
    if (sanitized.length === 0) {
      throw new Error("description must be non-empty after stripping whitespace/newlines");
    }
    let result: string;
    try {
      result = await executeLua(code, timeoutMs ?? DEFAULT_TIMEOUT_MS, sanitized);
    } catch (err) {
      const errCount = readBridgeErrorCount();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}\n---\nbridge_errors: ${errCount}`);
    }
    const errCount = readBridgeErrorCount();
    const text = `${result}\n---\nbridge_errors: ${errCount}`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "clear_callbacks",
  `Remove Lua callbacks that were registered via execute_lua.

The Mesen bridge wraps emu.addEventCallback and emu.addMemoryCallback to track every callback registered through execute_lua in a table (_mcpCallbacks). This tool removes them by label (or all at once), preventing callbacks from accumulating across sessions.

Parameters:
  - label (optional): the label string passed as the last argument when the callback was registered.
      - Provided → removes all callbacks with that exact label.
      - Omitted  → removes every tracked callback (full reset).

Label pattern — when registering callbacks via execute_lua, always pass a label:
  emu.addEventCallback(fn, emu.eventType.endFrame, "frame counter")
  emu.addMemoryCallback(fn, emu.callbackType.write, 0x7E0010, 0x7E0010, emu.memType.snesMemory, "hp watcher")

Then clear selectively:
  clear_callbacks({ label: "frame counter" })   -- removes only the frame counter hook
  clear_callbacks({})                           -- removes all tracked callbacks

Returns a confirmation message with the number of callbacks removed.

Note: the bridge's own internal tick callback is never tracked and cannot be cleared.`,
  {
    label: z.string().optional()
      .describe("Label of the callbacks to remove. Omit to remove all tracked callbacks."),
  },
  async ({ label }) => {
    const code        = label !== undefined ? `_mcpClearCallback(${JSON.stringify(label)})` : `_mcpClearCallbacks()`;
    const description = label !== undefined ? `clear callbacks: ${label}` : "clear all callbacks";
    let result: string;
    try {
      result = await executeLua(code, DEFAULT_TIMEOUT_MS, description);
    } catch (err) {
      const errCount = readBridgeErrorCount();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg}\n---\nbridge_errors: ${errCount}`);
    }
    const errCount = readBridgeErrorCount();
    return { content: [{ type: "text", text: `${result}\n---\nbridge_errors: ${errCount}` }] };
  },
);

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupSession();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Last-resort: write to stderr (stdout is reserved for MCP framing).
  process.stderr.write(`mesen-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
