import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

/* What the tools actually put on the wire.
 *
 * handshake.test.mjs points at 127.0.0.1:1 on purpose, so it can prove a tool
 * registers but never what a tool SENDS. That gap is not theoretical: for a
 * while resolve_rush_item forwarded its own vocabulary ("keep"/"skip") to a
 * route that only accepts "ship"/"stage"/"pass", so every keep came back 400 —
 * and nothing here failed, because nothing here had ever completed a request.
 *
 * So these tests stand up a real HTTP server, hand the process a credential
 * pointed at it, and assert on the recorded request. Still hermetic: the mock
 * is on loopback with an ephemeral port and the token is fake, so a regression
 * cannot reach a real deployment.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function withRecorder(run) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        path: new URL(req.url, "http://placeholder").pathname,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /* baseUrl must match, or api.ts rejects the credential as belonging to another
     deployment before it ever issues a request. */
  const home = mkdtempSync(join(tmpdir(), "piko-wire-"));
  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({
      token: "wire-test-token",
      baseUrl,
      expiresAt: null,
      account: { id: "u", email: "wire@test", name: "Wire" },
      loggedInAt: new Date().toISOString(),
    }),
  );

  const client = new Client({ name: "wire", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "index.js")],
      env: { ...process.env, PIKOREELS_URL: baseUrl, PIKOREELS_HOME: home },
    }),
  );
  try {
    return await run(client, requests);
  } finally {
    await client.close();
    server.close();
  }
}

const ITEM_ID = "91a425b3-2693-42d4-8cba-1d2766ff97b8";

/* The deck's verdicts are 'ship' | 'stage' | 'pass' (RushResolutionDecision in
   lib/rush-feed.ts); this tool's are 'keep' | 'skip'. The translation is the
   contract, and it is asserted here rather than imported because this package
   ships on its own — same reasoning as CLIENT_ID in src/config.ts. Change the
   route's vocabulary and this test is the thing that has to change with it.

   'keep' is deliberately 'stage', not 'ship': staging closes the card and leaves
   the reel in the lineup, and the route may promote stage->ship later but never
   the reverse. A tool called "keep" must not publish as a side effect. */
test("resolve_rush_item translates keep/skip into the deck's own verbs", async () => {
  await withRecorder(async (client, requests) => {
    for (const [decision, expected] of [["keep", "stage"], ["skip", "pass"]]) {
      requests.length = 0;
      const result = await client.callTool({
        name: "resolve_rush_item",
        arguments: { itemId: ITEM_ID, decision },
      });
      assert.notEqual(result.isError, true, `${decision} should not error`);
      assert.equal(requests.length, 1, `${decision} should make exactly one request`);
      const [sent] = requests;
      assert.equal(sent.method, "POST");
      assert.equal(sent.path, "/api/rush/resolve");
      assert.deepEqual(
        sent.body,
        { itemId: ITEM_ID, decision: expected },
        `${decision} must reach the route as ${expected}`,
      );
    }
  });
});

/* Guards the cross-cutting work api.ts does once for every tool. A dropped
   bearer is a flat 401 that reads exactly like an expired login, and a missing
   content-type makes a route parse an empty body and answer "field required"
   about a field that was sent — both are long debugs from a one-line cause. */
test("write calls carry the bearer, the workspace and a JSON content-type", async () => {
  await withRecorder(async (client, requests) => {
    await client.callTool({
      name: "resolve_rush_item",
      arguments: { itemId: ITEM_ID, decision: "skip", workspaceId: ITEM_ID },
    });
    const [sent] = requests;
    assert.equal(sent.headers.authorization, "Bearer wire-test-token");
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.headers["x-workspace-id"], ITEM_ID);
    assert.match(sent.headers["user-agent"], /PikoReels MCP/);
  });
});

/* Every tool that talks to the app must reach a real /api path. This is the
   cheap version of the audit that caught the rush mismatch: it will not tell
   you a body is wrong, but it does fail loudly if a tool is ever pointed at a
   path the app does not serve. Read-only and idempotent tools only — nothing
   here should need arguments to answer. */
test("read tools all address the app under /api", async () => {
  await withRecorder(async (client, requests) => {
    const { tools } = await client.listTools();
    const readOnly = tools.filter(
      (tool) => tool.annotations?.readOnlyHint === true && !(tool.inputSchema?.required ?? []).length,
    );
    assert.ok(readOnly.length >= 5, `expected several argument-free read tools, got ${readOnly.length}`);
    for (const tool of readOnly) {
      requests.length = 0;
      await client.callTool({ name: tool.name, arguments: {} });
      for (const sent of requests) {
        assert.match(sent.path, /^\/api\//, `${tool.name} called ${sent.path}`);
      }
    }
  });
});

/* schedule_rush_lineup is the only route from a Rush card to a calendar, so the
   shape it sends is worth pinning. Two things in particular: the card's own field
   names go through untranslated, and an omitted optional is ABSENT from the body
   rather than sent as null — /api/automations/lineup distinguishes the two for
   `spec`, where absent means "use the default placement" and malformed is an
   error, so a helpfully-added `spec: null` would be a caption in the wrong place. */
test("schedule_rush_lineup forwards the card's own fields and omits what wasn't given", async () => {
  await withRecorder(async (client, requests) => {
    const result = await client.callTool({
      name: "schedule_rush_lineup",
      arguments: {
        items: [
          {
            kind: "reel",
            rushItemId: ITEM_ID,
            videoId: "7da80227-f0ae-4ade-949c-571935c77769",
            caption: "line one\nline two",
            postTitle: "Title",
            postDescription: "Body",
            hashtags: ["one", "two"],
          },
        ],
        accountIds: ["acct-1", "acct-2"],
      },
    });
    assert.notEqual(result.isError, true);
    assert.equal(requests.length, 1);
    const [sent] = requests;
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/api/automations/lineup");
    assert.deepEqual(sent.body.accountIds, ["acct-1", "acct-2"]);
    assert.equal(sent.body.items.length, 1);

    const [item] = sent.body.items;
    assert.equal(item.rushItemId, ITEM_ID);
    assert.equal(item.videoId, "7da80227-f0ae-4ade-949c-571935c77769");
    assert.equal(item.caption, "line one\nline two");
    assert.deepEqual(item.hashtags, ["one", "two"]);

    /* The whole point of the server-side default. */
    assert.ok(!("spec" in item), "an omitted spec must not be sent at all");
    for (const key of ["startDate", "postTimes", "timezone", "name"]) {
      assert.ok(!(key in sent.body), `${key} was not given and must not be sent`);
    }
  });
});

test("schedule_rush_lineup passes through scheduling and per-platform copy when given", async () => {
  await withRecorder(async (client, requests) => {
    await client.callTool({
      name: "schedule_rush_lineup",
      arguments: {
        items: [
          {
            kind: "slideshow",
            slideshowId: "64fc65bb-b64b-4df6-8796-049506d4189b",
            slides: [{ position: 1, headline: "H", body: "B" }],
            postCopy: { v: 1, platforms: { tiktok: { title: "t" } } },
          },
        ],
        accountIds: ["acct-1"],
        startDate: "2026-09-12",
        postTimes: ["09:00", "18:00"],
        timezone: "Asia/Kolkata",
        name: "probe run",
      },
    });
    const [sent] = requests;
    assert.equal(sent.body.startDate, "2026-09-12");
    assert.deepEqual(sent.body.postTimes, ["09:00", "18:00"]);
    assert.equal(sent.body.timezone, "Asia/Kolkata");
    assert.equal(sent.body.name, "probe run");
    const [item] = sent.body.items;
    assert.equal(item.kind, "slideshow");
    assert.equal(item.slideshowId, "64fc65bb-b64b-4df6-8796-049506d4189b");
    assert.deepEqual(item.slides, [{ position: 1, headline: "H", body: "B" }]);
    /* postCopy is forwarded verbatim; the server is the one place its shape is decided. */
    assert.deepEqual(item.postCopy, { v: 1, platforms: { tiktok: { title: "t" } } });
  });
});

/* It creates a plan and nothing else. If this tool ever starts publishing, the
   annotation is what a client uses to decide whether to prompt first. */
test("schedule_rush_lineup is a write but not destructive", async () => {
  await withRecorder(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "schedule_rush_lineup");
    assert.ok(tool, "schedule_rush_lineup must be registered");
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.notEqual(tool.annotations?.destructiveHint, true);
    /* The agent should not need to go looking for the rest of the flow. */
    for (const mentioned of ["publish_automation", "resolve_rush_item", "get_rush_feed"]) {
      assert.ok(tool.description.includes(mentioned), `description should name ${mentioned}`);
    }
  });
});
