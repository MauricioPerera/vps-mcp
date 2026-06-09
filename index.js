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
import { readFileSync, statSync } from "node:fs";
import { basename, posix } from "node:path";

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
// MCP server definition
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "vps-mcp",
  version: "1.1.0",
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
      const safePath = `'${String(path).replace(/'/g, "'\\''")}'`;
      const r = await sshExec(
        `size=$(wc -c < ${safePath} 2>/dev/null || echo -1); echo "__SIZE__:$size"; head -c ${maxBytes} ${safePath}`,
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
