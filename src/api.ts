import { BASE_URL, USER_AGENT } from "./config.js";
import { loadCredentials } from "./store.js";

/* The one place this package talks to the app.
 *
 * Everything a tool does is a request through here, which is what makes the
 * three cross-cutting concerns solvable once rather than thirty times: the
 * bearer token, the workspace header, and turning an HTTP failure into a
 * sentence a model can act on.
 *
 * THE ERROR TRANSLATION IS THE INTERESTING PART. An MCP tool that fails by
 * throwing "HTTP 402" teaches the model nothing — it will retry, fail again, and
 * eventually tell the user something vague. The app is unusually good at saying
 * why it refused (quota bodies carry the metric and the plan, workspace limits
 * carry the ceiling), so the job here is to not throw that away: surface the
 * server's own sentence, and add the one piece of context the server could not
 * know, which is that the caller is a tool and what it should do next.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NotLoggedInError extends Error {
  constructor(message = "Not signed in. Run `piko-mcp login` in a terminal, then try again.") {
    super(message);
    this.name = "NotLoggedInError";
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body. Omit for GET/DELETE. */
  body?: unknown;
  /** Appended as a query string; undefined and null entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Overrides the session's default workspace for this one call. */
  workspaceId?: string | null;
};

/** The workspace every call is scoped to unless a tool names another. Set by the
 *  `use_workspace` tool and held for the life of the process — a per-request
 *  header rather than a stored cookie, so switching is free and never leaks into
 *  the next session. */
let activeWorkspaceId: string | null = null;

export function setActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id;
}

export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}

function extractMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const value = body as { error?: unknown; message?: unknown };
    if (typeof value.error === "string" && value.error) return value.error;
    if (typeof value.message === "string" && value.message) return value.message;
  }
  return `Request failed with HTTP ${status}.`;
}

export async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const credentials = loadCredentials();
  if (!credentials) throw new NotLoggedInError();

  /* A token minted by one deployment is meaningless at another, and the failure
     it produces (a flat 401 on every call) looks exactly like an expired login.
     Catching it here means the message names the actual problem. */
  if (credentials.baseUrl && credentials.baseUrl !== BASE_URL) {
    throw new NotLoggedInError(
      `Signed in to ${credentials.baseUrl}, but this server is pointed at ${BASE_URL}. Run \`piko-mcp login\` again, or unset PIKOREELS_URL.`,
    );
  }

  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const workspaceId = options.workspaceId ?? activeWorkspaceId;
  const headers: Record<string, string> = {
    authorization: `Bearer ${credentials.token}`,
    accept: "application/json",
    /* Named on every call, not just the login, so the row in Settings > Security
       keeps reporting this process for as long as it is the one using the
       session — Better Auth refreshes the row as a session is used. */
    "user-agent": USER_AGENT,
  };
  /* The app resolves this ahead of its cookie and re-checks ownership against
     the session, so an id belonging to someone else falls back to the caller's
     default rather than erroring. Sending it per request is what lets one
     process work across several workspaces without any stored state. */
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    /* DNS, TLS, a laptop that went to sleep. Named as a connection problem so the
       model stops rather than retrying a request that cannot succeed. */
    throw new ApiError(
      `Couldn't reach ${BASE_URL}: ${cause instanceof Error ? cause.message : String(cause)}`,
      0,
      null,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* An HTML body from a route that 500'd, or a proxy's error page. Keep the
         first part of it — it is usually enough to identify what answered. */
      body = { error: text.slice(0, 400) };
    }
  }

  if (response.ok) return body as T;

  if (response.status === 401) {
    throw new NotLoggedInError(
      "The saved login is no longer valid — it may have expired or been signed out from Settings › Security. Run `piko-mcp login` again.",
    );
  }
  if (response.status === 402) {
    /* The app's quota body carries the plan and the metric that ran out. Passing
       its sentence through unchanged is better than anything this layer could
       compose, because it already names the specific allowance. */
    throw new ApiError(
      `${extractMessage(body, 402)} This is a plan limit — it cannot be worked around from here, and a new plan has to be bought in the app.`,
      402,
      body,
    );
  }
  if (response.status === 429) {
    throw new ApiError("Rate limited by the server. Wait a moment before retrying.", 429, body);
  }

  throw new ApiError(extractMessage(body, response.status), response.status, body);
}
