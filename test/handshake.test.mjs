import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/* Does the thing an MCP client does, over a real stdio pipe.
 *
 * Worth having as a test rather than a manual check because the two ways this
 * server can be broken are both invisible from the outside: a bad tool schema is
 * rejected during registration (so the process dies before a client ever sees
 * it), and anything that writes to stdout corrupts the frame (so the client
 * disconnects on a parse error that names neither cause). Both show up here as a
 * failed handshake, and nowhere else until someone tries to use it.
 *
 * No login required — listing tools never touches the API. */

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* An empty directory as the credential home, so these run identically whether or
   not the developer executing them happens to be signed in. Without this the
   signed-out assertion below quietly stops testing anything the moment somebody
   runs `login` on their own machine. */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "piko-mcp-test-"));

async function connect() {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "index.js")],
      /* Pointed at a host that does not resolve, so a test that accidentally
         made a network call fails loudly instead of hitting production. */
      env: {
        ...process.env,
        PIKOREELS_URL: "http://127.0.0.1:1",
        PIKOREELS_HOME: EMPTY_HOME,
      },
    }),
  );
  return client;
}

test("handshake succeeds and every tool registers", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 30, `expected the full tool set, got ${tools.length}`);

    for (const tool of tools) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not snake_case`);
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
      assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
    }

    const names = new Set(tools.map((tool) => tool.name));
    assert.equal(names.size, tools.length, "tool names must be unique");
    for (const required of ["whoami", "list_workspaces", "list_studio_models", "generate_video"]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
  } finally {
    await client.close();
  }
});

test("no billing tool is exposed", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const banned = tools.filter((tool) =>
      /billing|checkout|payment|purchase|buy_|change_plan|credits_/.test(tool.name),
    );
    assert.deepEqual(banned.map((tool) => tool.name), [], "buying must stay browser-only");
  } finally {
    await client.close();
  }
});

test("destructive tools are annotated as such", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    /* These are the ones a client should be prompting about. If an annotation is
       ever dropped, the tool silently becomes auto-approvable. */
    for (const name of ["delete_workspace", "cancel_posts", "delete_upload", "disconnect_account"]) {
      assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} must be destructive`);
    }
    assert.equal(byName.get("whoami")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("generate_video")?.annotations?.readOnlyHint, false);
  } finally {
    await client.close();
  }
});

test("a call with no credentials explains how to log in", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "whoami",
      arguments: {},
      /* A home directory with no credentials file in it, so this exercises the
         signed-out path regardless of whether the developer running the tests
         happens to be logged in. */
    });
    assert.equal(result.isError, true);
    /* Specifically the not-signed-in message, not merely "something failed" —
       the credential home above guarantees that is the branch taken, and the
       point of the tool is that it tells the user what to do about it. */
    assert.match(result.content[0].text, /piko-mcp login/);
  } finally {
    await client.close();
  }
});
