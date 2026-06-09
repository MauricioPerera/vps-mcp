#!/usr/bin/env node
/**
 * vps-mcp — Stateless MCP server for connecting to a VPS over SSH.
 *
 * "Stateless" means: no persistent connection is kept between tool calls.
 * Every tool invocation opens a fresh SSH connection, runs the work, and
 * closes it. This keeps the server simple and avoids stale/dangling sessions.
 *
 * Credentials are defined once via environment variables (set in the MCP
 * client config) and can be overridden per call via tool arguments.
 *
 * Transport: stdio (run locally by an MCP client such as Claude Code/Desktop).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "ssh2";
import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { basename, posix, dirname as localDirname } from "node:path";

// ---------------------------------------------------------------------------
// Defaults pulled from environment (set these in your MCP client config).
// ---------------------------------------------------------------------------
const ENV = {
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
 */
function buildConnConfig(args = {}) {
  const host = args.host || ENV.host;
  const port = args.port || ENV.port;
  const username = args.username || ENV.username;
  const password = args.password || ENV.password;
  const privateKeyPath = args.privateKeyPath || ENV.privateKeyPath;
  const passphrase = args.passphrase || ENV.passphrase;

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

/**
 * Open an SSH connection, run a single command, collect stdout/stderr/exit
 * code, then close. Fully stateless.
 */
function sshExec(command, args = {}) {
  const config = buildConnConfig(args);
  const timeoutMs = args.timeoutMs || ENV.timeoutMs;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      reject(new Error(`Command timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch {}
      fn(val);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) return finish(reject, err);
          stream
            .on("close", (code, signal) => {
              finish(resolve, {
                code: code ?? null,
                signal: signal ?? null,
                stdout,
                stderr,
                host: config.host,
              });
            })
            .on("data", (d) => { stdout += d.toString("utf8"); })
            .stderr.on("data", (d) => { stderr += d.toString("utf8"); });
        });
      })
      .on("error", (err) => finish(reject, err))
      .connect(config);
  });
}

/**
 * Open an SSH connection, run an SFTP operation via the provided callback,
 * then close. The callback receives (sftp) and must call done(err, result).
 * Fully stateless, same connection/timeout handling as sshExec.
 */
function sshSftp(work, args = {}) {
  const config = buildConnConfig(args);
  const timeoutMs = args.timeoutMs || ENV.timeoutMs;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      reject(new Error(`SFTP operation timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch {}
      fn(val);
    };

    conn
      .on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) return finish(reject, err);
          work(sftp, (e, result) => {
            if (e) return finish(reject, e);
            finish(resolve, { ...result, host: config.host });
          });
        });
      })
      .on("error", (err) => finish(reject, err))
      .connect(config);
  });
}

/** Quote a path for safe use inside a single-quoted shell string. */
function shQuote(p) {
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Background tasks (for commands that run longer than the call timeout).
//
// The task lives on the VPS, not in this stateless server: the command is
// launched detached (setsid/nohup), its output and exit code are written to
// files under a task directory, and a taskId is returned. Subsequent calls
// (status/logs/stop) are independent SSH connections that just read/poke those
// files — nothing is held open here.
// ---------------------------------------------------------------------------

/**
 * Parse the `key=value` lines between the __META__ and __TAIL__ markers into a
 * plain object. Per-field so a single malformed/empty value degrades only that
 * field instead of nulling the whole status (robustness fix).
 */
function parseMetaBlock(stdout) {
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
function assertTaskId(id) {
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
function resolveTaskState({ alive, exitCode, status }) {
  if (exitCode !== null && exitCode !== undefined && exitCode !== "") {
    return { state: "finished", exitCode: Number(exitCode) };
  }
  if (alive) return { state: "running", exitCode: null };
  if (status === "stopped") return { state: "stopped", exitCode: null };
  // Dead, no recorded exit code, and never marked stopped -> it died on its own.
  return { state: "crashed", exitCode: null };
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "vps-mcp",
  version: "1.4.0",
});

// Shared optional override schema so any tool can override the env defaults.
const overrideShape = {
  host: z.string().optional().describe("Override VPS host/IP"),
  port: z.number().int().optional().describe("Override SSH port (default 22)"),
  username: z.string().optional().describe("Override SSH user (default root)"),
  password: z.string().optional().describe("Override SSH password"),
  privateKeyPath: z.string().optional().describe("Override path to a private key file"),
  passphrase: z.string().optional().describe("Passphrase for the private key, if any"),
  timeoutMs: z.number().int().optional().describe("Command timeout in ms (default 60000)"),
};

function textResult(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}

// Tool: run an arbitrary command on the VPS.
server.registerTool(
  "ssh_exec",
  {
    title: "Run a command on the VPS",
    description:
      "Open a fresh SSH connection to the configured VPS, run a single shell command, and return stdout, stderr and the exit code. Stateless — the connection is closed after each call.",
    inputSchema: {
      command: z.string().describe("The shell command to execute on the VPS"),
      ...overrideShape,
    },
  },
  async ({ command, ...args }) => {
    try {
      const r = await sshExec(command, args);
      return textResult(r);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `SSH error: ${e.message}` }] };
    }
  }
);

// Tool: quick connectivity / auth check.
server.registerTool(
  "ssh_test_connection",
  {
    title: "Test the VPS connection",
    description:
      "Verify SSH connectivity and authentication to the configured VPS by running a lightweight identity command. Returns the resolved hostname and current user.",
    inputSchema: { ...overrideShape },
  },
  async (args) => {
    try {
      const r = await sshExec("echo OK; id -un; hostname", args);
      const ok = r.code === 0;
      return textResult({ connected: ok, ...r });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Connection failed: ${e.message}` }] };
    }
  }
);

// Tool: read a remote file (convenience over `cat`, with size guard).
server.registerTool(
  "ssh_read_file",
  {
    title: "Read a file from the VPS",
    description:
      "Read the contents of a remote file via SSH. Refuses files larger than maxBytes (default 1 MiB) to avoid flooding the context.",
    inputSchema: {
      path: z.string().describe("Absolute path of the remote file to read"),
      maxBytes: z.number().int().optional().describe("Max bytes to read (default 1048576)"),
      ...overrideShape,
    },
  },
  async ({ path, maxBytes = 1048576, ...args }) => {
    try {
      // head -c keeps us under the limit; wc -c reports the true size.
      const safePath = shQuote(path);
      const r = await sshExec(
        `size=$(wc -c < ${safePath} 2>/dev/null || echo -1); echo "__SIZE__:$size"; head -c ${Number(maxBytes)} ${safePath}`,
        args
      );
      const m = r.stdout.match(/^__SIZE__:(-?\d+)\n?/);
      const size = m ? Number(m[1]) : null;
      const body = m ? r.stdout.slice(m[0].length) : r.stdout;
      if (size === -1) {
        return { isError: true, content: [{ type: "text", text: `File not found or unreadable: ${path}` }] };
      }
      const truncated = size != null && size > maxBytes;
      return textResult({
        path,
        size,
        truncated,
        content: body,
        stderr: r.stderr || undefined,
      });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Read failed: ${e.message}` }] };
    }
  }
);

// Tool: upload a local file to the VPS (for deployments, artifacts, tarballs).
server.registerTool(
  "ssh_upload_file",
  {
    title: "Upload a file to the VPS",
    description:
      "Upload a local file to a remote path on the VPS over SFTP. Useful for deployments and shipping artifacts. Creates the remote parent directory if needed. Stateless — connection closed after the transfer.",
    inputSchema: {
      localPath: z.string().describe("Absolute path of the local file to upload"),
      remotePath: z
        .string()
        .describe("Remote destination path. If it ends with '/', the local filename is appended."),
      mode: z
        .string()
        .optional()
        .describe("Optional octal permissions for the uploaded file, e.g. '0755' for an executable"),
      mkdirp: z
        .boolean()
        .optional()
        .describe("Create the remote parent directory if missing (default true)"),
      ...overrideShape,
    },
  },
  async ({ localPath, remotePath, mode, mkdirp = true, ...args }) => {
    try {
      let size;
      try {
        size = statSync(localPath).size;
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Local file not found: ${localPath}` }] };
      }
      // If remotePath ends with '/', treat it as a directory and keep the name.
      const dest = remotePath.endsWith("/")
        ? posix.join(remotePath, basename(localPath))
        : remotePath;

      if (mkdirp) {
        const dir = posix.dirname(dest);
        await sshExec(`mkdir -p ${shQuote(dir)}`, args);
      }

      const r = await sshSftp((sftp, done) => {
        const opts = mode ? { mode: parseInt(mode, 8) } : {};
        sftp.fastPut(localPath, dest, opts, (err) => {
          if (err) return done(err);
          done(null, { localPath, remotePath: dest, bytes: size });
        });
      }, args);

      return textResult({ uploaded: true, ...r, mode: mode || undefined });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Upload failed: ${e.message}` }] };
    }
  }
);

// Tool: write text content directly to a remote file (configs, .env, scripts).
server.registerTool(
  "ssh_write_file",
  {
    title: "Write text to a file on the VPS",
    description:
      "Write string content directly to a remote file over SFTP, without needing a local file. Ideal for config files, .env, or small scripts. Overwrites by default. Creates the remote parent directory if needed.",
    inputSchema: {
      remotePath: z.string().describe("Absolute remote path of the file to write"),
      content: z.string().describe("The text content to write"),
      mode: z
        .string()
        .optional()
        .describe("Optional octal permissions, e.g. '0644' or '0755' for a script"),
      append: z.boolean().optional().describe("Append instead of overwrite (default false)"),
      mkdirp: z
        .boolean()
        .optional()
        .describe("Create the remote parent directory if missing (default true)"),
      ...overrideShape,
    },
  },
  async ({ remotePath, content, mode, append = false, mkdirp = true, ...args }) => {
    try {
      if (mkdirp) {
        const dir = posix.dirname(remotePath);
        await sshExec(`mkdir -p ${shQuote(dir)}`, args);
      }
      const buf = Buffer.from(content, "utf8");
      const r = await sshSftp((sftp, done) => {
        const flags = append ? "a" : "w";
        const opts = { flags, encoding: null };
        if (mode) opts.mode = parseInt(mode, 8);
        const ws = sftp.createWriteStream(remotePath, opts);
        ws.on("close", () => done(null, { remotePath, bytes: buf.length, append }));
        ws.on("error", (err) => done(err));
        ws.end(buf);
      }, args);
      return textResult({ written: true, ...r, mode: mode || undefined });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Write failed: ${e.message}` }] };
    }
  }
);

// Tool: download a remote file to the local disk (backups, artifacts, binaries).
server.registerTool(
  "ssh_download_file",
  {
    title: "Download a file from the VPS",
    description:
      "Download a remote file from the VPS to a local path over SFTP. Handles binaries and large files (no size limit), unlike ssh_read_file. Creates the local parent directory if needed. Stateless — connection closed after the transfer.",
    inputSchema: {
      remotePath: z.string().describe("Absolute path of the remote file to download"),
      localPath: z
        .string()
        .describe("Local destination path. If it ends with a separator, the remote filename is appended."),
      mkdirp: z
        .boolean()
        .optional()
        .describe("Create the local parent directory if missing (default true)"),
      ...overrideShape,
    },
  },
  async ({ remotePath, localPath, mkdirp = true, ...args }) => {
    try {
      // If localPath looks like a directory, keep the remote filename.
      const endsWithSep = /[\\/]$/.test(localPath);
      const dest = endsWithSep ? localPath + basename(remotePath) : localPath;

      if (mkdirp) {
        const dir = localDirname(dest);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      }

      const r = await sshSftp((sftp, done) => {
        // Confirm the remote file exists and grab its size first.
        sftp.stat(remotePath, (err, stats) => {
          if (err) return done(new Error(`Remote file not found or unreadable: ${remotePath}`));
          sftp.fastGet(remotePath, dest, (e2) => {
            if (e2) return done(e2);
            done(null, { remotePath, localPath: dest, bytes: stats.size });
          });
        });
      }, args);

      return textResult({ downloaded: true, ...r });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Download failed: ${e.message}` }] };
    }
  }
);

// Shared optional task-dir override for all task tools.
const taskDirShape = {
  taskDir: z
    .string()
    .optional()
    .describe("Remote directory holding task state (default /tmp/vps-mcp-tasks or VPS_TASK_DIR)"),
};

// Tool: start a long-running command as a detached background task.
server.registerTool(
  "ssh_task_start",
  {
    title: "Start a long-running command (background task)",
    description:
      "Launch a command on the VPS as a detached background task that keeps running after the SSH connection closes. Returns a taskId to poll with ssh_task_status / ssh_task_logs. Use this instead of ssh_exec for anything that may exceed the call timeout (builds, upgrades, deploys, backups).",
    inputSchema: {
      command: z.string().describe("The shell command to run in the background"),
      ...taskDirShape,
      ...overrideShape,
    },
  },
  async ({ command, taskDir, ...args }) => {
    try {
      const root = taskDir || ENV.taskDir;
      const b64 = Buffer.from(command, "utf8").toString("base64");
      // Runner records output, exit code and status; detaches via setsid/nohup.
      const runner =
        'sh "$0/cmd.sh" >"$0/output.log" 2>&1; ec=$?; printf "%s" "$ec" > "$0/exit"; echo finished > "$0/status"';
      const script =
        `set -e\n` +
        `ROOT=${shQuote(root)}\n` +
        `mkdir -p "$ROOT"\n` +
        `TDIR=$(mktemp -d "$ROOT/task-XXXXXXXX")\n` +
        `printf '%s' ${shQuote(b64)} | base64 -d > "$TDIR/cmd.sh"\n` +
        `(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo) > "$TDIR/started"\n` +
        `echo running > "$TDIR/status"\n` +
        `if command -v setsid >/dev/null 2>&1; then\n` +
        `  setsid sh -c '${runner}' "$TDIR" </dev/null >/dev/null 2>&1 &\n` +
        `else\n` +
        `  nohup sh -c '${runner}' "$TDIR" </dev/null >/dev/null 2>&1 &\n` +
        `fi\n` +
        `echo $! > "$TDIR/pid"\n` +
        `echo "__TASK__ id=$(basename "$TDIR") pid=$(cat "$TDIR/pid")"\n`;

      const r = await sshExec(script, args);
      const m = r.stdout.match(/__TASK__ id=(task-[A-Za-z0-9]+) pid=(\d+)/);
      if (!m) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not start task. stdout: ${r.stdout}\nstderr: ${r.stderr}` }],
        };
      }
      return textResult({
        started: true,
        taskId: m[1],
        pid: Number(m[2]),
        taskDir: root,
        host: r.host,
        hint: "Poll with ssh_task_status; fetch output with ssh_task_logs.",
      });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Task start failed: ${e.message}` }] };
    }
  }
);

// Tool: check a background task's status (running / finished / stopped / crashed) + tail.
server.registerTool(
  "ssh_task_status",
  {
    title: "Get a background task's status",
    description:
      "Report a background task's state — running, finished (with exit code), stopped (killed via ssh_task_stop) or crashed (died on its own: external kill, OOM, reboot) — plus the last lines of its output. Stateless poll over a fresh SSH connection.",
    inputSchema: {
      taskId: z.string().describe("The taskId returned by ssh_task_start"),
      lines: z.number().int().optional().describe("How many trailing output lines to include (default 40)"),
      ...taskDirShape,
      ...overrideShape,
    },
  },
  async ({ taskId, lines = 40, taskDir, ...args }) => {
    try {
      assertTaskId(taskId);
      const root = taskDir || ENV.taskDir;
      const tdir = `${root}/${taskId}`;
      const script =
        `TDIR=${shQuote(tdir)}\n` +
        `if [ ! -d "$TDIR" ]; then echo __NOTFOUND__; exit 0; fi\n` +
        `PID=$(cat "$TDIR/pid" 2>/dev/null)\n` +
        `ST=$(cat "$TDIR/status" 2>/dev/null)\n` +
        `EX=$(cat "$TDIR/exit" 2>/dev/null)\n` +
        `STARTED=$(cat "$TDIR/started" 2>/dev/null)\n` +
        `ALIVE=no; if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then ALIVE=yes; fi\n` +
        // One key=value per line so a malformed field can't sink the whole parse.
        `echo __META__\n` +
        `echo "pid=$PID"\n` +
        `echo "status=$ST"\n` +
        `echo "exit=$EX"\n` +
        `echo "alive=$ALIVE"\n` +
        `echo "started=$STARTED"\n` +
        `echo __TAIL__\n` +
        `tail -n ${Number(lines)} "$TDIR/output.log" 2>/dev/null\n`;
      const r = await sshExec(script, args);
      if (r.stdout.includes("__NOTFOUND__")) {
        return { isError: true, content: [{ type: "text", text: `Task not found: ${taskId}` }] };
      }
      const meta = parseMetaBlock(r.stdout);
      const tail = r.stdout.split("__TAIL__\n")[1] || "";
      const alive = meta.alive === "yes";
      const { state, exitCode } = resolveTaskState({
        alive,
        exitCode: meta.exit,
        status: meta.status,
      });
      return textResult({
        taskId,
        state,
        exitCode,
        pid: /^\d+$/.test(meta.pid || "") ? Number(meta.pid) : null,
        startedAt: meta.started || null,
        outputTail: tail,
        host: r.host,
      });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Status failed: ${e.message}` }] };
    }
  }
);

// Tool: fetch a background task's output log.
server.registerTool(
  "ssh_task_logs",
  {
    title: "Fetch a background task's output",
    description:
      "Return the output (stdout+stderr) captured by a background task. By default returns the last `lines` lines; set full=true to return the whole log (bounded by maxBytes).",
    inputSchema: {
      taskId: z.string().describe("The taskId returned by ssh_task_start"),
      lines: z.number().int().optional().describe("Trailing lines to return when full=false (default 200)"),
      full: z.boolean().optional().describe("Return the entire log instead of the tail (default false)"),
      maxBytes: z.number().int().optional().describe("Cap when full=true (default 1048576)"),
      ...taskDirShape,
      ...overrideShape,
    },
  },
  async ({ taskId, lines = 200, full = false, maxBytes = 1048576, taskDir, ...args }) => {
    try {
      assertTaskId(taskId);
      const root = taskDir || ENV.taskDir;
      const log = `${root}/${taskId}/output.log`;
      const reader = full
        ? `head -c ${Number(maxBytes)} ${shQuote(log)}`
        : `tail -n ${Number(lines)} ${shQuote(log)}`;
      const script =
        `if [ ! -f ${shQuote(log)} ]; then echo __NOTFOUND__; exit 0; fi\n` +
        `SIZE=$(wc -c < ${shQuote(log)} 2>/dev/null || echo -1)\n` +
        `echo "__SIZE__:$SIZE"\n` +
        reader + `\n`;
      const r = await sshExec(script, args);
      if (r.stdout.includes("__NOTFOUND__")) {
        return { isError: true, content: [{ type: "text", text: `Task log not found: ${taskId}` }] };
      }
      const m = r.stdout.match(/^__SIZE__:(-?\d+)\n?/);
      const size = m ? Number(m[1]) : null;
      const body = m ? r.stdout.slice(m[0].length) : r.stdout;
      return textResult({
        taskId,
        size,
        truncated: full && size != null && size > maxBytes,
        output: body,
        host: r.host,
      });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Logs failed: ${e.message}` }] };
    }
  }
);

// Tool: stop (and optionally remove) a background task.
server.registerTool(
  "ssh_task_stop",
  {
    title: "Stop a background task",
    description:
      "Terminate a running background task (SIGTERM then SIGKILL to the whole process group). Optionally remove its task directory afterwards.",
    inputSchema: {
      taskId: z.string().describe("The taskId returned by ssh_task_start"),
      remove: z.boolean().optional().describe("Delete the task directory after stopping (default false)"),
      ...taskDirShape,
      ...overrideShape,
    },
  },
  async ({ taskId, remove = false, taskDir, ...args }) => {
    try {
      assertTaskId(taskId);
      const root = taskDir || ENV.taskDir;
      const tdir = `${root}/${taskId}`;
      const script =
        `TDIR=${shQuote(tdir)}\n` +
        `if [ ! -d "$TDIR" ]; then echo __NOTFOUND__; exit 0; fi\n` +
        `PID=$(cat "$TDIR/pid" 2>/dev/null)\n` +
        `if [ -n "$PID" ]; then\n` +
        `  kill -TERM -"$PID" 2>/dev/null; kill -TERM "$PID" 2>/dev/null; pkill -TERM -P "$PID" 2>/dev/null\n` +
        `  sleep 1\n` +
        `  kill -KILL -"$PID" 2>/dev/null; kill -KILL "$PID" 2>/dev/null; pkill -KILL -P "$PID" 2>/dev/null\n` +
        `fi\n` +
        `echo stopped > "$TDIR/status" 2>/dev/null || true\n` +
        (remove ? `rm -rf "$TDIR"\n` : ``) +
        `echo "__STOPPED__ pid=$PID"\n`;
      const r = await sshExec(script, args);
      if (r.stdout.includes("__NOTFOUND__")) {
        return { isError: true, content: [{ type: "text", text: `Task not found: ${taskId}` }] };
      }
      const m = r.stdout.match(/__STOPPED__ pid=(\d*)/);
      return textResult({ stopped: true, taskId, pid: m?.[1] ? Number(m[1]) : null, removed: remove, host: r.host });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Stop failed: ${e.message}` }] };
    }
  }
);

// Tool: list background tasks and their states.
server.registerTool(
  "ssh_task_list",
  {
    title: "List background tasks",
    description:
      "List all background tasks under the task directory with their state, pid, exit code and start time.",
    inputSchema: { ...taskDirShape, ...overrideShape },
  },
  async ({ taskDir, ...args }) => {
    try {
      const root = taskDir || ENV.taskDir;
      const script =
        `ROOT=${shQuote(root)}\n` +
        `[ -d "$ROOT" ] || { echo __EMPTY__; exit 0; }\n` +
        `found=no\n` +
        `for d in "$ROOT"/task-*; do\n` +
        `  [ -d "$d" ] || continue\n` +
        `  found=yes\n` +
        `  PID=$(cat "$d/pid" 2>/dev/null); ST=$(cat "$d/status" 2>/dev/null); EX=$(cat "$d/exit" 2>/dev/null); STARTED=$(cat "$d/started" 2>/dev/null)\n` +
        `  ALIVE=no; if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then ALIVE=yes; fi\n` +
        `  echo "$(basename "$d")|$PID|$ST|$EX|$ALIVE|$STARTED"\n` +
        `done\n` +
        `[ "$found" = no ] && echo __EMPTY__ || true\n`;
      const r = await sshExec(script, args);
      const tasks = [];
      if (!r.stdout.includes("__EMPTY__")) {
        for (const line of r.stdout.trim().split("\n")) {
          const [id, pid, status, ex, alive, started] = line.split("|");
          if (!id || !id.startsWith("task-")) continue;
          const { state, exitCode } = resolveTaskState({
            alive: alive === "yes",
            exitCode: ex,
            status,
          });
          tasks.push({
            taskId: id,
            state,
            exitCode,
            pid: pid ? Number(pid) : null,
            startedAt: started || null,
          });
        }
      }
      return textResult({ count: tasks.length, taskDir: root, tasks, host: r.host });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `List failed: ${e.message}` }] };
    }
  }
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: never write to stdout here — stdio is the MCP channel. Use stderr.
  process.stderr.write("vps-mcp running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`vps-mcp fatal: ${e.stack || e}\n`);
  process.exit(1);
});
