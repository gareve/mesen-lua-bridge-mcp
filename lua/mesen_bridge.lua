-- mesen_bridge.lua
-- File-based bridge between an external MCP server and Mesen 2's Lua sandbox.
--
-- Reads request.lua written by the MCP server, evaluates it, and writes
-- response.txt back. Single in-flight request per session, identified by SEQ
-- so a stale response from a timed-out call cannot be mistaken for a fresh one.
--
-- Requires Mesen's "Allow access to I/O and OS functions" toggle to be ON.
-- Bumping "Script timeout" to 10s is recommended.

-- Both sides must agree on a single path. On POSIX we hardcode /tmp because
-- macOS GUI apps (Mesen) and CLI children (the MCP server) often have
-- different $TMPDIR values, which would split the rendezvous. On Windows
-- there is no universal equivalent, so fall back to %TEMP% / %TMP%.
local function isWindows()
  return package.config:sub(1, 1) == "\\"
end
local function tmpdir()
  if isWindows() then
    local env = os.getenv("TEMP") or os.getenv("TMP")
    if env and #env > 0 then return (env:gsub("[/\\]$", "")) end
    return "C:\\Temp"
  end
  return "/tmp"
end

local BRIDGE_ROOT        = tmpdir() .. "/mesen-mcp"
local ACTIVE_PTR         = BRIDGE_ROOT .. "/active"
local ERROR_LOG          = BRIDGE_ROOT .. "/mesen_errors.log"
local ERROR_COUNT_FILE   = BRIDGE_ROOT .. "/error_count.txt"
local POLL_ACTIVE_EVERY  = 60     -- frames between re-reading the active pointer (~1s at 60Hz)

local sessionDir = nil
local tickCount  = 0

_errorCount = 0

----------------------------------------------------------------------------
-- IO helpers
----------------------------------------------------------------------------

local function readFile(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("*a")
  f:close()
  return data
end

local function writeFileAtomic(path, content)
  local tmp = path .. ".tmp"
  local f, err = io.open(tmp, "wb")
  if not f then return false, err end
  f:write(content)
  f:close()
  local ok, rerr = os.rename(tmp, path)
  if not ok then
    pcall(os.remove, tmp)
    return false, rerr
  end
  return true
end

local function logSafe(msg)
  if emu and emu.log then
    pcall(emu.log, msg)
  end
end

local function appendErrorLog(msg)
  local f = io.open(ERROR_LOG, "ab")
  if not f then return end
  f:write(msg .. "\n")
  f:close()
  _errorCount = _errorCount + 1
  pcall(writeFileAtomic, ERROR_COUNT_FILE, tostring(_errorCount))
  logSafe("[mesen-mcp] error #" .. _errorCount .. ": " .. (msg:match("^([^\n]+)") or msg))
end

----------------------------------------------------------------------------
-- Session pointer
----------------------------------------------------------------------------

local function refreshSessionDir()
  local data = readFile(ACTIVE_PTR)
  if not data then return end
  local trimmed = data:match("^%s*(.-)%s*$")
  if not trimmed or #trimmed == 0 then return end
  if trimmed == sessionDir then return end
  sessionDir = trimmed
  -- Announce script presence to this session by writing the epoch file.
  pcall(writeFileAtomic, sessionDir .. "/epoch", tostring(os.time()))
  logSafe("[mesen-mcp] bound to session " .. sessionDir)
end

----------------------------------------------------------------------------
-- Lua evaluation
----------------------------------------------------------------------------

local function evaluate(src)
  -- Tier 1: try as expression so bare values return implicitly (REPL-style).
  local chunk, err = load("return (" .. src .. "\n)", "user", "t")
  if not chunk then
    -- Tier 2: try as a statement block.
    chunk, err = load(src, "user", "t")
  end
  if not chunk then
    return false, "syntax error: " .. tostring(err or "unknown")
  end
  return xpcall(chunk, debug.traceback)
end

local function renderResults(results)
  if results.n <= 1 then return "" end
  local parts = {}
  for i = 2, results.n do
    parts[#parts + 1] = tostring(results[i])
  end
  return table.concat(parts, "\t")
end

----------------------------------------------------------------------------
-- Request processing
----------------------------------------------------------------------------

local function buildResponse(seq, status, payload)
  return "SEQ:" .. seq .. "\n"
      .. status .. "\n"
      .. "LEN " .. #payload .. "\n"
      .. payload .. "\n"
end

local function processRequest()
  if not sessionDir then return end
  local reqPath  = sessionDir .. "/request.lua"
  local respPath = sessionDir .. "/response.txt"

  local body = readFile(reqPath)
  if not body then return end

  -- Delete the request immediately. If eval hangs and Mesen aborts the script
  -- (Script timeout), we don't want it to replay on the next script load.
  pcall(os.remove, reqPath)

  -- Parse the request header. Preferred format (current MCP server):
  --   SEQ:<n>\nDESC:<one-line description, possibly empty>\n<lua source>
  -- Legacy format (older MCP servers without DESC support):
  --   SEQ:<n>\n<lua source>
  local seq, desc, src = body:match("^SEQ:(%S+)\nDESC:([^\n]*)\n(.*)$")
  if not seq then
    seq, src = body:match("^SEQ:(%S+)\n(.*)$")
    desc = ""
  end
  if not seq then
    pcall(writeFileAtomic, respPath,
      buildResponse("0", "ERR", "malformed request: missing SEQ: header"))
    return
  end

  if desc and #desc > 0 then
    logSafe("[mesen-mcp] " .. desc)
  end

  local results = table.pack(evaluate(src))
  local ok = results[1]
  local status, payload
  if ok then
    status  = "OK"
    payload = renderResults(results)
  else
    status  = "ERR"
    payload = tostring(results[2] or "<unknown error>")
    appendErrorLog("[seq=" .. seq .. "] " .. payload)
  end

  pcall(writeFileAtomic, respPath, buildResponse(seq, status, payload))
end

----------------------------------------------------------------------------
-- Tick (called once per emulated frame)
----------------------------------------------------------------------------

local function tick()
  tickCount = tickCount + 1
  if (tickCount % POLL_ACTIVE_EVERY) == 1 then
    pcall(refreshSessionDir)
  end
  pcall(processRequest)
end

----------------------------------------------------------------------------
-- Bootstrap
----------------------------------------------------------------------------

pcall(os.remove, ERROR_LOG)
pcall(os.remove, ERROR_COUNT_FILE)
pcall(refreshSessionDir)

if not emu or not emu.addEventCallback then
  logSafe("[mesen-mcp] ERROR: emu.addEventCallback unavailable; not running inside Mesen?")
  return
end

emu.addEventCallback(tick, emu.eventType.endFrame)

if sessionDir then
  logSafe("[mesen-mcp] bridge active (session " .. sessionDir .. ")")
else
  logSafe("[mesen-mcp] bridge registered; waiting for an MCP server to claim "
       .. ACTIVE_PTR)
end
