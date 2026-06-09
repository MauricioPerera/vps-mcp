#!/usr/bin/env node
/**
 * Minimal MCP stdio client to smoke-test vps-mcp end-to-end.
 * Spawns index.js, lists tools, then calls ssh_test_connection and a sample
 * ssh_exec. Credentials come from the same VPS_* env vars as the server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(__dirname, "index.js")],
  env: process.env,
});

const client = new Client({ name: "vps-mcp-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

console.log("\n-- ssh_test_connection --");
const test = await client.callTool({ name: "ssh_test_connection", arguments: {} });
console.log(test.content[0].text);

console.log("\n-- ssh_exec: uptime --");
const exec = await client.callTool({ name: "ssh_exec", arguments: { command: "uptime" } });
console.log(exec.content[0].text);

if (process.argv.includes("--write")) {
  console.log("\n-- ssh_write_file --");
  const w = await client.callTool({
    name: "ssh_write_file",
    arguments: {
      remotePath: "/tmp/vps-mcp-test/hello.sh",
      content: "#!/bin/sh\necho 'deployed via vps-mcp'\n",
      mode: "0755",
    },
  });
  console.log(w.content[0].text);

  console.log("\n-- ssh_exec: run the written script --");
  const run = await client.callTool({
    name: "ssh_exec",
    arguments: { command: "/tmp/vps-mcp-test/hello.sh" },
  });
  console.log(run.content[0].text);

  console.log("\n-- cleanup --");
  await client.callTool({ name: "ssh_exec", arguments: { command: "rm -rf /tmp/vps-mcp-test" } });
}

await client.close();
process.exit(0);
