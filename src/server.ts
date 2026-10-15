import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiError, NotLoggedInError } from "./api.js";
import { BASE_URL } from "./config.js";
import { ALL_TOOLS } from "./tools/index.js";

/* Wiring the tool table onto stdio.
 *
 * Stdio rather than HTTP, and that choice is worth stating: it is the transport
 * every MCP client supports without exception, it needs no port and no
 * certificate, and it keeps the credential on the machine that owns it rather
 * than putting a bearer token on a network. An HTTP transport would let this run
 * as a shared service, which is precisely the thing a per-user token should not
 * be used for.
 *
 * STDOUT IS THE PROTOCOL. Every diagnostic in this package goes to stderr, and a
 * stray console.log anywhere in a tool handler is a corrupt JSON-RPC frame and a
 * client that disconnects with an unhelpful parse error. That is the single
 * easiest way to break an MCP server and it fails in a way that looks like
 * anything but the cause.
 */

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "pikoreels", version: "0.1.0" },
    {
      instructions: [
        "PikoReels — AI UGC generation, scheduling and analytics for TikTok, Instagram and YouTube.",
        "",
        "Start with `whoami`. It names the plan, what allowance is left, and which workspace the",
        "other tools act on. If the account has more than one workspace, confirm which one before",
        "generating or publishing — content, connected social accounts and analytics are all",
        "per-workspace, and there is no undo for putting a client's reel on another client's channel.",
        "",
        "Generation costs real money from a finite balance. Call `list_studio_models` for ids and",
        "prices before `generate_image` or `generate_video`; the ids are not guessable and tiers",
        "differ by more than ten times in cost. Charges land when a job is accepted, not when it",
        "succeeds.",
        "",
        "`schedule_generation` and `publish_automation` publish to real public accounts. Get the",
        "user's explicit go-ahead first, every time. Nothing here can unpublish.",
        "",
        "Buying is not available through this server — plans, credit top-ups and payment methods",
        "are deliberately browser-only. If an allowance runs out, say so and stop.",
      ].join("\n"),
    },
  );

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema ?? {},
        annotations: {
          title: tool.title,
          ...tool.annotations,
          /* Everything here reaches a remote API, so no tool is closed-world.
             Clients use this to decide how much to trust a cached result. */
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(args ?? {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          /* Returned as an error RESULT rather than thrown. A thrown handler
             becomes a protocol-level error, which most clients surface as "the
             tool failed" with the message buried; an isError result is delivered
             to the model as content it can read and act on — which is what these
             messages were written for, since half of them explain what to do
             next. */
          return {
            isError: true,
            content: [{ type: "text" as const, text: describeFailure(error) }],
          };
        }
      },
    );
  }

  return server;
}

function describeFailure(error: unknown): string {
  if (error instanceof NotLoggedInError) return error.message;
  if (error instanceof ApiError) {
    return error.status ? `${error.message} (HTTP ${error.status})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function serve(): Promise<void> {
  const server = buildServer();
  /* stderr, for the reason at the top of the file. Clients log it, so it is the
     one place to say which deployment this process is pointed at — the most
     common misconfiguration is a stale PIKOREELS_URL and this makes it visible
     without a tool call. */
  process.stderr.write(
    `pikoreels-mcp: ${ALL_TOOLS.length} tools, talking to ${BASE_URL}\n`,
  );
  await server.connect(new StdioServerTransport());
}
