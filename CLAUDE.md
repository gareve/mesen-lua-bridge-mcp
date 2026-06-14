# mesen-lua-bridge-mcp — Claude Code context

## Architecture

File-based bridge between this MCP server (TypeScript) and a Lua script running inside Mesen 2.

```
Claude → MCP server (src/server.ts) → /tmp/mesen-mcp/<pid>/request.lua
                                     ← /tmp/mesen-mcp/<pid>/response.txt ← lua/mesen_bridge.lua (inside Mesen)
```

- **`src/server.ts`** — MCP server. Exposes a single tool `execute_lua`. Writes `request.lua`, polls for `response.txt`. Serializes concurrent calls with a mutex.
- **`lua/mesen_bridge.lua`** — Loaded in Mesen's Script Window. Hooks `emu.eventType.endFrame`, polls for `request.lua` each frame, evaluates it with `xpcall`, writes `response.txt`.

The session directory is `BRIDGE_ROOT/<server-pid>`. The `active` pointer file tells the Lua side which session is current.

## Running the server

```bash
npm install
npx tsx src/server.ts   # or via .mcp.json (auto-picked up by Claude Code)
```

No build step — `tsx` runs TypeScript directly.

## Key tmp files

| Path | Purpose |
|---|---|
| `/tmp/mesen-mcp/active` | Points to the active session dir |
| `/tmp/mesen-mcp/<pid>/request.lua` | In-flight Lua request (deleted after read) |
| `/tmp/mesen-mcp/<pid>/response.txt` | Bridge response; deleted after read |
| `/tmp/mesen-mcp/<pid>/epoch` | Written by Lua on bind; used for timeout diagnostics |
| `/tmp/mesen-mcp/mesen_errors.log` | All Lua ERR responses since last bridge reload, with full tracebacks |
| `/tmp/mesen-mcp/error_count.txt` | Cumulative error count; read by the server to append `bridge_errors: N` to every response |

## Error tracking

Every `execute_lua` response appends `\n---\nbridge_errors: N` so the LLM always sees cumulative error count. On ERR responses the trailer is appended to the thrown error. The count and log reset when the Lua bridge is reloaded.

## Wire format

Request (`request.lua`):
```
SEQ:<n>
DESC:<one-line description>
<lua source>
```

Response (`response.txt`):
```
SEQ:<n>
OK|ERR
LEN <bytes>
<payload>
```

## Lua eval semantics

1. Tries `return (<src>)` first — bare expressions work REPL-style.
2. Falls back to statement block if that fails to parse.
3. Uses `xpcall(chunk, debug.traceback)` — full traceback on error.

## Personal identity for commits

Use `gareve` / `1031137+gareve@users.noreply.github.com`, not the global git config work identity.
