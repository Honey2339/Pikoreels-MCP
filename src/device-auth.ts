import { spawn } from "node:child_process";
import { BASE_URL, CLIENT_ID, LOGIN_TIMEOUT_MS, USER_AGENT } from "./config.js";
import { saveCredentials, type Credentials } from "./store.js";

/* Signing a terminal in, per RFC 8628.
 *
 * The shape of the problem: this process has no browser, no redirect URI to
 * receive an OAuth callback on, and no business being trusted with a Google
 * password. So it asks the server for a pair of codes, shows the human the short
 * one, and polls until they have approved it somewhere we already trust. The
 * secret half — the device code — never leaves this process, and the half the
 * human handles is useless on its own.
 *
 * The polling rules below are the specification's, not ours, and they matter:
 * `interval` is a floor the server enforces (poll faster and it answers
 * slow_down), `authorization_pending` means keep going, and everything else is
 * terminal. Getting this wrong produces a login that appears to hang.
 */

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

export type LoginEvents = {
  /** Called once, as soon as there is a code to show. */
  onPrompt: (prompt: { userCode: string; verificationUri: string; completeUri: string }) => void;
};

export class LoginError extends Error {}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_description?: string; error?: string };
    return body.error_description || body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Ask the server for a code pair. */
async function requestCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(`${BASE_URL}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "" }),
  });
  if (!response.ok) {
    throw new LoginError(
      `Couldn't start the login (${await readError(response)}). Check that PIKOREELS_URL points at a deployment that has device login enabled — currently ${BASE_URL}.`,
    );
  }
  return (await response.json()) as DeviceCodeResponse;
}

/* Open the approval page for them.
 *
 * Best effort, and silent when it fails. A CLI cannot know whether it is running
 * on a desktop, in a container, or over SSH, and an unopenable browser is not an
 * error — the URL was already printed and the flow works perfectly well by hand.
 * Failing the login because `open` is missing would be the tail wagging the dog.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* No browser to open. The printed URL is the fallback and always was. */
  }
}

/* Where to actually send the browser.
 *
 * The server tells us, via verification_uri, and we deliberately do not take it
 * at face value. That URL is built from the deployment's own BETTER_AUTH_URL,
 * which is a separate setting from the host we just talked to and drifts from it
 * constantly — a dev server on :3001 with BETTER_AUTH_URL still on :3000 hands
 * back an approval link pointing at whatever else is running there, and the user
 * gets a 404, or worse, an unrelated app's login page.
 *
 * So the PATH comes from the server (it knows where its own page lives) and the
 * ORIGIN comes from the host we were configured to talk to. Beyond fixing the
 * common misconfiguration, this is the safer composition: a response from a host
 * should not be able to decide which OTHER host we open in the user's browser,
 * and the code being approved is only good on the deployment that minted it
 * anyway.
 */
function approvalUrl(code: DeviceCodeResponse): string {
  const source = code.verification_uri_complete ?? code.verification_uri;
  let path = "/device";
  try {
    const parsed = new URL(source, BASE_URL);
    path = `${parsed.pathname}${parsed.search}`;
    if (parsed.origin !== new URL(BASE_URL).origin) {
      process.stderr.write(
        `pikoreels-mcp: server suggested ${parsed.origin} for approval; using ${BASE_URL} instead (check BETTER_AUTH_URL on the deployment).\n`,
      );
    }
  } catch {
    /* An unparseable verification_uri. The default path is the documented one
       and the code is on the query string below either way. */
  }
  const url = new URL(path, BASE_URL);
  url.searchParams.set("user_code", code.user_code);
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the whole flow: request a code, show it, wait for approval, store the
 * token. Resolves with the credential it wrote.
 */
export async function login(events: LoginEvents): Promise<Credentials> {
  const code = await requestCode();
  const completeUri = approvalUrl(code);

  events.onPrompt({
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    completeUri,
  });
  openBrowser(completeUri);

  /* The server's floor, in milliseconds, with a 5s fallback for a response that
     omitted it. Mutable because a `slow_down` answer requires us to raise it. */
  /* The extra 250ms is deliberate headroom. The server rejects a poll that
     arrives less than `pollingInterval` after the previous one, measured from
     when IT recorded the last poll — so sleeping exactly the interval races the
     clock skew between the two machines and answers slow_down on a fast link.
     A quarter second costs nothing and removes the race. */
  let intervalMs = Math.max(1, code.interval || 5) * 1000 + 250;
  /* Whichever runs out first: the code's own lifetime, or our ceiling. Honouring
     expires_in means we stop at the moment the code dies rather than polling a
     corpse for another ten minutes. */
  const deadline = Date.now() + Math.min(LOGIN_TIMEOUT_MS, (code.expires_in || 900) * 1000);

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const response = await fetch(`${BASE_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: CLIENT_ID,
      }),
    });

    if (response.ok) {
      const token = (await response.json()) as { access_token: string; expires_in?: number };
      if (!token.access_token) throw new LoginError("The server approved the login but sent no token.");
      const credentials: Credentials = {
        token: token.access_token,
        baseUrl: BASE_URL,
        expiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000).toISOString()
          : null,
        /* Filled in by the caller, which has an API client to ask with. Kept out
           of here so this function stays purely the grant. */
        account: null,
        loggedInAt: new Date().toISOString(),
      };
      saveCredentials(credentials);
      return credentials;
    }

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };

    switch (body.error) {
      case "authorization_pending":
        /* The normal answer for most of this loop — they have not clicked yet. */
        continue;
      case "slow_down":
        /* Mandated by the spec: back off by 5s and keep going. Not an error, and
           treating it as one is the classic way to break a device flow. */
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new LoginError("Login was declined in the browser. Nothing was connected.");
      case "expired_token":
        throw new LoginError("The code expired before it was approved. Run `login` again.");
      default:
        throw new LoginError(body.error_description || body.error || `HTTP ${response.status}`);
    }
  }

  throw new LoginError("Timed out waiting for approval. Run `login` again.");
}
