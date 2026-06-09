/**
 * Unit tests for the pure helpers in lib.js. Run with `node --test`.
 * No network, no VPS — these cover the logic the review flagged as risky.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  shQuote,
  parseMetaBlock,
  assertTaskId,
  resolveTaskState,
  buildConnConfig,
} from "../lib.js";

test("shQuote escapes single quotes safely", () => {
  assert.equal(shQuote("/tmp/file"), "'/tmp/file'");
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  // A classic injection attempt stays fully contained inside the quotes.
  assert.equal(shQuote("'; rm -rf /; '"), "''\\''; rm -rf /; '\\'''");
});

test("parseMetaBlock parses key=value lines per field", () => {
  const out = parseMetaBlock(
    "__META__\npid=123\nstatus=running\nexit=\nalive=yes\nstarted=2026-06-09T00:00:00Z\n__TAIL__\nhello\n"
  );
  assert.equal(out.pid, "123");
  assert.equal(out.status, "running");
  assert.equal(out.exit, "");
  assert.equal(out.alive, "yes");
  assert.equal(out.started, "2026-06-09T00:00:00Z");
});

test("parseMetaBlock keeps '=' inside values", () => {
  const out = parseMetaBlock("__META__\nstarted=a=b=c\n__TAIL__\n");
  assert.equal(out.started, "a=b=c");
});

test("parseMetaBlock tolerates missing markers", () => {
  assert.deepEqual(parseMetaBlock("no markers here"), {});
  assert.deepEqual(parseMetaBlock(""), {});
});

test("assertTaskId accepts valid ids and rejects bad ones", () => {
  assert.doesNotThrow(() => assertTaskId("task-AbC123"));
  for (const bad of ["task-", "task", "../etc", "task-a/b", "task a", "", null, undefined]) {
    assert.throws(() => assertTaskId(bad), /Invalid taskId/);
  }
});

test("resolveTaskState: finished with exit code", () => {
  assert.deepEqual(resolveTaskState({ alive: false, exitCode: "0", status: "finished" }), {
    state: "finished",
    exitCode: 0,
  });
  assert.deepEqual(resolveTaskState({ alive: false, exitCode: "3", status: "finished" }), {
    state: "finished",
    exitCode: 3,
  });
});

test("resolveTaskState: running wins while alive", () => {
  assert.equal(resolveTaskState({ alive: true, exitCode: "", status: "running" }).state, "running");
});

test("resolveTaskState: stopped vs crashed are distinct", () => {
  // Killed deliberately via ssh_task_stop (status file set to "stopped").
  assert.equal(
    resolveTaskState({ alive: false, exitCode: "", status: "stopped" }).state,
    "stopped"
  );
  // Died on its own: dead, no exit code, status still "running".
  assert.equal(
    resolveTaskState({ alive: false, exitCode: "", status: "running" }).state,
    "crashed"
  );
});

test("buildConnConfig throws when host is missing", () => {
  assert.throws(() => buildConnConfig({}, { username: "root", password: "x" }), /No host/);
});

test("buildConnConfig throws when no auth method is provided", () => {
  assert.throws(
    () => buildConnConfig({ host: "h" }, { host: "h", username: "root" }),
    /No authentication/
  );
});

test("buildConnConfig uses password auth and applies overrides", () => {
  const conf = buildConnConfig(
    { host: "1.2.3.4", port: 2222, username: "deploy", password: "pw" },
    {}
  );
  assert.equal(conf.host, "1.2.3.4");
  assert.equal(conf.port, 2222);
  assert.equal(conf.username, "deploy");
  assert.equal(conf.password, "pw");
  assert.ok(!("privateKey" in conf));
});

test("buildConnConfig prefers a private key over a password", () => {
  const keyPath = join(tmpdir(), `vps-mcp-test-key-${process.pid}`);
  writeFileSync(keyPath, "FAKE-KEY-CONTENT");
  try {
    const conf = buildConnConfig(
      { host: "h", privateKeyPath: keyPath, password: "ignored" },
      {}
    );
    assert.ok(Buffer.isBuffer(conf.privateKey));
    assert.equal(conf.privateKey.toString(), "FAKE-KEY-CONTENT");
    assert.ok(!("password" in conf));
  } finally {
    rmSync(keyPath, { force: true });
  }
});

test("buildConnConfig surfaces an unreadable key path", () => {
  assert.throws(
    () => buildConnConfig({ host: "h", privateKeyPath: "/does/not/exist/key" }, {}),
    /Could not read private key/
  );
});
