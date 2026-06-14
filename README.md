# mesen-lua-bridge-mcp

An MCP server that lets an LLM execute arbitrary Lua inside the running Mesen 2 emulator. The LLM can read the MESEN 2 Lua documentation and come up with arbitrary Lua code, no need to encode that API into the MCP commands. This keeps the architecture & version compatibility much simpler. It also gives more freedom to the LLM to come up with interesting solutions.

Should work for any system Mesen 2 supports; tested with SNES.

Each call carries a short description that's logged to Mesen's Script Window, so you can follow along, audit what ran, and learn from the process — which makes it a great fit for picking up reverse engineering with an LLM narrating each step. Later you can ask the LLM why it did certain steps.


Demo below (Lightly scripted to keep it short, but based on a real debugging session)

https://github.com/user-attachments/assets/3379bf00-03aa-425e-a089-717eec883cae

I used this MCP + Claude Code to reverse engineer & write this [Inindo Way of the Ninja Patcher Web Tool](https://github.com/gareve/inindo-way-of-the-ninja-snes-patcher)

## Prerequisites

- macOS, Linux, or Windows (the bridge dir is resolved from `TMPDIR` / `TMP` / `TEMP`, falling back to `/tmp`)
- Node.js ≥ 18 (tested on 22)
- [Mesen 2](https://www.mesen.ca/)
- A ROM for any system Mesen supports

## One-time Mesen setup

In Mesen's UI:

1. Launch Mesen, load any ROM.
2. **Tools → Script Window**.
3. In the Script Window, open its **Settings** (gear icon or menu) and enable **"Allow access to I/O and OS functions"**. The "Allow network access" toggle is not needed.
4. In the same Settings dialog, raise **"Script timeout"** from the default 1 second to **10 seconds**. The 1s default will abort legitimate RE snippets like memory scans.
5. Leave **"Auto-start script on load"**, **"Auto-reload script when file changes"**, and **"Auto-restart script after power cycle"** at their defaults (all on). These give you clean restart UX.

https://github.com/user-attachments/assets/3d1a4c9d-0ab6-46a8-b2ba-331ba4b2c1ea

## Install the server

```bash
git clone https://github.com/gareve/mesen-lua-bridge-mcp.git
cd mesen-lua-bridge-mcp
npm install
```

## Load the bridge in Mesen

In Mesen's Script Window: **File → Open** → select `lua/mesen_bridge.lua` from your clone of this repo → click **Run**.

You should see a line in the script console:

```
[mesen-mcp] bridge registered; waiting for an MCP server to claim <tmp>/mesen-mcp/active
```

(or `[mesen-mcp] bound to session ...` if the MCP server is already running.)


## Wire into Claude Code (or any other MCP-compatible LLM)

A project-scoped `.mcp.json` is committed in this repo, so Claude Code will pick it up automatically when you run `claude` from the project directory. Confirm with:

```bash
claude mcp list
```

If you'd rather wire it user-scope (available from any directory), run this from inside the cloned repo:

```bash
claude mcp add mesen --cwd "$(pwd)" -- npx tsx src/server.ts
```

**Other MCP clients** (ChatGPT, Cursor, Cline, Zed, Continue, etc.) — this is a standard stdio MCP server. Configure your client to run `npx tsx src/server.ts` with the cloned repo as its working directory.

## LLM Smoke Test

In your MCP client (e.g. Claude):

> Use the mesen tool to run `return 1 + 1`.

Expect `2`. Then try a real one:

> Use the mesen tool to run `return emu.read(0x7E0000)`.

Expect a number 0–255 (a byte of RAM).

## LLM Reliability checklist (manual end-to-end verification)

Walk through these once to confirm the no-restart story holds. Each step assumes the smoke test above already worked.

| # | Test | Expected |
|---|---|---|
| 1 | `execute_lua("return 1+1")` cold | `2` |
| 2 | Kill the MCP server (find its PID, `kill <pid>`), call again | Works without touching Mesen — the MCP client respawns the server |
| 3 | Quit Mesen, relaunch, reload ROM, call again | Works (script auto-starts, epoch increments) |
| 4 | In Mesen's Script Window: Stop, then Run, on the bridge script | Works |
| 5 | Swap ROM in Mesen, call | Works (bridge auto-restarts) |
| 6 | Quit + restart the MCP client | Works (new MCP PID, old session dir GC'd) |
| 7 | Issue 50 quick calls in succession | All return in order |
| 8 | `execute_lua("for i=1,1e9 do end")` | Mesen aborts the script after `Script timeout`; MCP returns the timeout diagnostic |
| 9 | `rm -rf /tmp/mesen-mcp/<pid>/` while running, call | Recovers within ~1s |
| 10 | Toggle "Allow access to I/O and OS functions" off, reload script, call | MCP timeout with the "check AllowIoOsAccess" hint |
| 11 | Quit ROM (keep Mesen open), call | MCP timeout; load ROM → next call succeeds |
| 12 | `execute_lua("return emu.read(0x7E0000)")` | Numeric result |

## Troubleshooting

**"timeout: no response from Mesen Lua bridge"** — the diagnostic message lists common causes. Most of the time it's:

- `Allow access to I/O and OS functions` is OFF → bridge can't write files.
- The bridge script isn't loaded (or was loaded but stopped).
- No ROM is running → no `endFrame` callbacks → no polling.
- Snippet exceeded Mesen's `Script timeout` → Mesen aborted the script.

**"Error from Mesen Lua: ... attempt to call a nil value"** — your snippet referenced an `emu.*` function that doesn't exist on the loaded system. Check the [API reference](https://www.mesen.ca/docs/apireference.html) — some functions are system-specific.

**Stale results after a timeout** — fixed by SEQ tagging in the wire format; if you ever see this please file it.

**Your MCP client can't see the tool** — for Claude Code, `claude mcp list` should show `mesen`; check `.mcp.json` is being loaded (use `claude` from the project dir) or run the `claude mcp add` command above. For other clients, verify the stdio server is launched with the repo as its working directory.

## Error visibility

Every `execute_lua` response — success or failure — includes a trailer:

```
---
bridge_errors: 3
```

`bridge_errors` is a cumulative count of Lua errors since the bridge script was last loaded. It resets to 0 on each bridge reload. When the LLM sees it increment, it knows something went wrong even if the most recent call succeeded.

Errors are also:
- Printed to Mesen's Script Window console (first line only, no stack trace): `[mesen-mcp] error #3: ...`
- Written to `/tmp/mesen-mcp/mesen_errors.log` with full stack traces and sequence numbers, wiped on each bridge reload.

## Known limitations (PoC scope)

- **Single in-flight request per session.** Concurrent `execute_lua` calls serialize via a mutex. Fine for interactive RE work; revisit if you want pipelined batch operations.
- **`tostring()`-based result rendering.** Tables come back as `table: 0x...`. Add a small JSON encoder in Lua when the first nested-result use case appears.
- **No streaming output.** `print()` from inside a snippet is lost (it goes to Mesen's script console only). If you want stdout from the snippet, append to a log file in the session dir and have the server collect it.

## Why file-based transport, not sockets

Sockets are possible, but unreliable: Mesen's Lua `accept()` takes one client per script lifetime, then needs the script reloaded — which clashes with how MCP clients spawn and respawn servers. Files are much simpler and more reliable.

Bonus wins:

- **Reliability.** Survives restarts of the MCP server, Mesen, the bridge script, the MCP client, and ROM swaps — in any order.
- **Bandwidth.** No socket-buffer or fragmentation limits. Multi-megabyte responses (memory dumps, screenshots) work without chunking or tuning — limited only by tmpfs/disk.
- **No network-access permission.** Only the I/O/OS-functions toggle is needed; "Allow network access" stays off.
- **Inspectable with `cat`.** The in-flight request is just a file.
