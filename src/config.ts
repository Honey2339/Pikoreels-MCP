import { homedir } from "node:os";
import { join } from "node:path";

/* Where this server points, and who it says it is.
 *
 * Two knobs, both environment variables, because the two things that vary are
 * "which deployment" and "which account file" and neither belongs in a flag —
 * an MCP client launches this process from a JSON config with no shell around
 * it, so anything not readable from the environment is not settable at all.
 */

/** The deployment to talk to. Override for a local `next dev` or a preview URL. */
export const BASE_URL = (
  process.env.PIKOREELS_URL ?? "https://app.pikoreels.com"
).replace(/\/+$/, "");

/* Paired with the allowlist in the app's lib/mcp-clients.ts, which is what
   decides whether a device code is minted at all. Repeated rather than imported
   because this package ships on its own and cannot reach into the app; if it
   ever changes, both ends change together or login stops working — which is a
   loud failure at the first attempt rather than a quiet one later. */
export const CLIENT_ID = "pikoreels-mcp";

/* Sent as User-Agent on every request, including the token exchange.
 *
 * Better Auth stamps the user-agent of the request that creates a session onto
 * the session row, so this string is what makes the terminal's login show up in
 * the user's Settings > Security as "PikoReels MCP · Command line" rather than
 * as an unidentifiable row. That panel is the only place a token held by this
 * process can be revoked, so being nameable there is a security property, not a
 * nicety — nobody revokes with confidence what they cannot identify.
 *
 * Left as-is, Node's fetch sends `user-agent: node`, which is how the first
 * version of this ended up labelled "Browser · Unknown". Paired with
 * MCP_SESSION_USER_AGENT in the app's lib/mcp-clients.ts, which lib/user-agent.ts
 * matches on. Change one, change both. */
export const USER_AGENT = "PikoReels MCP (device grant)";

/* One file, holding one token, in a directory of our own.
 *
 * Under $HOME rather than beside the install: the credential belongs to the
 * person, not to the checkout, and an npx invocation has no stable install
 * directory to put it in anyway. PIKOREELS_HOME exists so a second account (or a
 * staging deployment) can be kept separately without the two overwriting each
 * other — point the MCP client's env at a different directory and it is a
 * different login. */
export const CONFIG_DIR =
  process.env.PIKOREELS_HOME ?? join(homedir(), ".pikoreels");

export const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

/** How long to keep polling /device/token before giving up on a login. Matches
 *  the 15-minute code lifetime the server issues, so the CLI never outlives the
 *  code it is waiting on and never gives up while the code is still good. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
