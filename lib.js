/**
 * vps-mcp — pure, side-effect-free helpers.
 *
 * Extracted from index.js so they can be unit-tested without booting the MCP
 * server (importing index.js would register tools / open stdio). Nothing here
 * touches the network; the only I/O is reading a key file in buildConnConfig.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Defaults pulled from environment (set these in your MCP client config).
// ---------------------------------------------------------------------------
export const ENV = {
  host: process.env.VPS_HOST,
  port: process.env.VPS_PORT ? Number(process.env.VPS_PORT) : 22,
  username: process.env.VPS_USER || "root",
  password: process.env.VPS_PASSWORD,
  privateKeyPath: process.env.VPS_KEY_PATH,
  passphrase: process.env.VPS_KEY_PASSPHRASE,
  // Default safety timeout for a single command, in ms.
  timeoutMs: process.env.VPS_TIMEOUT_MS ? Number(process.env.VPS_TIMEOUT_MS) : 60000,
  // Remote directory where background tasks store their state/output.
  taskDir: process.env.VPS_TASK_DIR || "/tmp/vps-mcp-tasks",
};

/**
 * Build the ssh2 connection config, merging env defaults with per-call
 * overrides. Throws a clear error if no auth method is available.
 *
 * `env` is injectable for testability; defaults to the module-level ENV.
 */
export function buildConnConfig(args = {}, env = ENV) {
  const host = args.host || env.host;
  const port = args.port || env.port;
  const username = args.username || env.username;
  const password = args.password || env.password;
  const privateKeyPath = args.privateKeyPath || env.privateKeyPath;
  const passphrase = args.passphrase || env.passphrase;

  if (!host) {
    throw new Error(
      "No host configured. Set VPS_HOST in the MCP config or pass `host` in the tool call."
    );
  }

  const conn = {
    host,
    port,
    username,
    readyTimeout: 20000,
    // Keepalive is harmless even for short-lived stateless connections.
    keepaliveInterval: 10000,
  };

  if (privateKeyPath) {
    try {
      conn.privateKey = readFileSync(privateKeyPath);
    } catch (e) {
      throw new Error(`Could not read private key at ${privateKeyPath}: ${e.message}`);
    }
    if (passphrase) conn.passphrase = passphrase;
  } else if (password) {
    conn.password = password;
  } else {
    throw new Error(
      "No authentication configured. Set VPS_PASSWORD or VPS_KEY_PATH (or pass them in the tool call)."
    );
  }

  return conn;
}

/** Quote a path for safe use inside a single-quoted shell string. */
export function shQuote(p) {
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}

/**
 * Parse the `key=value` lines between the __META__ and __TAIL__ markers into a
 * plain object. Per-field so a single malformed/empty value degrades only that
 * field instead of nulling the whole status (robustness fix).
 */
export function parseMetaBlock(stdout) {
  const out = {};
  const block = stdout.split("__META__\n")[1];
  if (!block) return out;
  const region = block.split("__TAIL__")[0];
  for (const line of region.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** taskIds are produced by `mktemp -d .../task-XXXXXXXX`; validate strictly. */
export function assertTaskId(id) {
  if (!/^task-[A-Za-z0-9]+$/.test(String(id || ""))) {
    throw new Error(`Invalid taskId: ${id}`);
  }
}

/**
 * Resolve the effective task status from the raw files. The four states are
 * distinguishable and not conflated:
 * - exit file present                         -> "finished" (with exitCode)
 * - process alive                              -> "running"
 * - dead + status marked "stopped"             -> "stopped" (killed by ssh_task_stop)
 * - dead + no exit + status still "running"    -> "crashed" (died without an exit
 *   code: external kill, OOM, host reboot...)
 *
 * The "stopped" vs "crashed" split matters operationally: "stopped" means we
 * killed it on purpose; "crashed" means it died on its own and warrants a look.
 */
export function resolveTaskState({ alive, exitCode, status }) {
  if (exitCode !== null && exitCode !== undefined && exitCode !== "") {
    return { state: "finished", exitCode: Number(exitCode) };
  }
  if (alive) return { state: "running", exitCode: null };
  if (status === "stopped") return { state: "stopped", exitCode: null };
  // Dead, no recorded exit code, and never marked stopped -> it died on its own.
  return { state: "crashed", exitCode: null };
}
