#!/usr/bin/env node
import { BASE_URL, CREDENTIALS_PATH } from "./config.js";
import { login, LoginError } from "./device-auth.js";
import { serve } from "./server.js";
import {
  clearCredentials,
  describeCredentials,
  loadCredentials,
  saveCredentials,
} from "./store.js";
import { request } from "./api.js";
import { formatUserCode } from "./format.js";

/* One binary, four verbs.
 *
 * `serve` is the default because that is how an MCP client launches this: it
 * spawns the command from a JSON config with no arguments and starts speaking
 * JSON-RPC at it immediately. Anything that printed a menu on a bare invocation
 * would be broken for the primary caller.
 *
 * The other three are for a human at a prompt. They write to stdout freely —
 * unlike `serve`, where stdout is the wire.
 */

const HELP = `pikoreels-mcp — MCP server for PikoReels

  piko-mcp              Run the MCP server on stdio (what a client invokes).
  piko-mcp login        Sign in, by approving a code in your browser.
  piko-mcp status       Show the current login.
  piko-mcp logout       Forget the saved credential.

Environment:
  PIKOREELS_URL         Deployment to talk to. Default ${BASE_URL}
  PIKOREELS_HOME        Where the credential is kept. Default ~/.pikoreels
`;

async function runLogin(): Promise<number> {
  try {
    const credentials = await login({
      onPrompt: ({ userCode, completeUri }) => {
        process.stdout.write(
          [
            "",
            `  Your code:  ${formatUserCode(userCode)}`,
            "",
            "  Opening your browser to approve it. If it doesn't open, go to:",
            `  ${completeUri}`,
            "",
            "  Waiting for approval…",
            "",
          ].join("\n"),
        );
      },
    });

    /* Name the account now that there is a token to ask with. Stored so `status`
       can answer without a round trip, and printed so the very first thing a
       user sees after approving is confirmation of WHICH account got connected —
       the one detail the browser step can get wrong when several are signed in. */
    try {
      /* Better Auth's own endpoint, not one of ours — it is the only thing that
         answers "who is this token" without also computing a plan. The bearer
         plugin turns the Authorization header into a session before it runs, so
         this works exactly like the browser calling it. */
      const session = (await request("/api/auth/get-session")) as {
        user?: { id?: string; email?: string | null; name?: string | null };
      };
      const plan = (await request("/api/me/plan")) as { plan?: string };
      const workspaces = (await request("/api/workspaces")) as {
        workspaces?: { id: string; name: string }[];
      };
      saveCredentials({
        ...credentials,
        account: session.user?.id
          ? {
              id: session.user.id,
              email: session.user.email ?? null,
              name: session.user.name ?? null,
            }
          : null,
      });
      process.stdout.write(
        `  Connected as ${session.user?.email ?? session.user?.name ?? "this account"}.\n` +
          `  Plan: ${plan.plan ?? "unknown"} · ${workspaces.workspaces?.length ?? 0} workspace(s).\n\n`,
      );
    } catch {
      /* The token is good — it was just minted. A failure here is the follow-up
         lookup, not the login, and saying "logged in but couldn't read your
         plan" is more honest than failing a login that succeeded. */
      process.stdout.write("  Connected.\n\n");
    }

    process.stdout.write(`  Credential saved to ${CREDENTIALS_PATH} (mode 0600).\n\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `\n  ${error instanceof LoginError ? error.message : String(error)}\n\n`,
    );
    return 1;
  }
}

function runStatus(): number {
  const credentials = loadCredentials();
  if (!credentials) {
    process.stdout.write(`\n  Not signed in. Run: piko-mcp login\n\n`);
    return 1;
  }
  const summary = describeCredentials(credentials);
  process.stdout.write(
    [
      "",
      `  Account:    ${summary.account}`,
      `  Deployment: ${summary.baseUrl || "(unknown)"}`,
      `  Signed in:  ${summary.loggedInAt}`,
      `  Expires:    ${summary.expiresAt ?? "unknown"}${summary.expired ? "  (EXPIRED — run login again)" : ""}`,
      `  File:       ${CREDENTIALS_PATH}`,
      "",
    ].join("\n"),
  );
  return summary.expired ? 1 : 0;
}

function runLogout(): number {
  clearCredentials();
  process.stdout.write("\n  Signed out locally.\n");
  /* Said explicitly because it is not what "logout" implies. Clearing the file
     stops THIS machine using the session; the session itself is still live on the
     server until it expires or is revoked, which is the only thing that helps if
     the file was already copied. */
  process.stdout.write(
    "  The session is still valid server-side — revoke it in Settings › Security\n  (it appears as “PikoReels MCP”) if you think the token was exposed.\n\n",
  );
  return 0;
}

const [command] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "serve":
    serve().catch((error) => {
      process.stderr.write(`pikoreels-mcp: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    });
    break;
  case "login":
    process.exit(await runLogin());
  case "status":
    process.exit(runStatus());
  case "logout":
    process.exit(runLogout());
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(HELP);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(1);
}
