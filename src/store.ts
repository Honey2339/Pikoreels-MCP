import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CONFIG_DIR, CREDENTIALS_PATH } from "./config.js";

/* The token on disk.
 *
 * What is stored here IS the session — anything holding it is signed in as the
 * user, exactly as if it had their browser cookie. Three consequences, and they
 * are the whole reason this is a module rather than two calls to fs:
 *
 * The file is 0600 and the directory 0700, set explicitly rather than left to
 * the process umask, because a default umask of 022 writes a world-readable file
 * and on a shared machine that is the entire security story lost in one line.
 * They are re-applied on every write: an existing file keeps its old mode, so
 * writing to a file that was created loosely once would stay loose forever.
 *
 * It is written atomically — a temp file in the same directory, then a rename —
 * so a crash mid-write leaves the previous credential intact rather than a
 * half-written JSON file that neither parses nor logs in.
 *
 * And nothing in this package ever prints `token`. The redacted summary below is
 * what `status` renders and what any error handler is allowed to touch, because
 * an MCP server's stderr goes somewhere the user does not control and does not
 * read — which is the perfect place to leak a credential into unnoticed.
 */

export type Credentials = {
  /** The Better Auth session token. Sent as `Authorization: Bearer`. */
  token: string;
  /** Which deployment minted it. A token from one host is meaningless on another,
   *  and silently sending it to the wrong one is a confusing 401 rather than an
   *  obvious "you are logged in to somewhere else". */
  baseUrl: string;
  /** ISO. Advisory only — the server is the authority on expiry, and this is
   *  here so `status` can say "expired" without a round trip. */
  expiresAt: string | null;
  /** For the same reason: so `status` can name the account without a request. */
  account: { id: string; email: string | null; name: string | null } | null;
  /** ISO, when this token was obtained. */
  loggedInAt: string;
};

export function loadCredentials(): Credentials | null {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<Credentials>;
    /* A token is the only field worth failing over. Everything else is a
       convenience for the status line, and a credentials file written by an
       older build should keep working rather than force a re-login. */
    if (typeof value.token !== "string" || !value.token) return null;
    return {
      token: value.token,
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
      expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
      account: value.account ?? null,
      loggedInAt:
        typeof value.loggedInAt === "string" ? value.loggedInAt : new Date(0).toISOString(),
    };
  } catch {
    /* Missing, unreadable or corrupt all mean the same thing to every caller:
       there is no usable login. The difference only matters to a human, and the
       remedy is identical in all three cases. */
    return null;
  }
}

export function saveCredentials(credentials: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  /* Same directory as the target, so the rename below is within one filesystem
     and therefore atomic. /tmp would not be. */
  const temp = `${CREDENTIALS_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  /* Explicit, because `mode` on writeFileSync is masked by the umask and only
     applies when the file is created — a temp path that somehow already existed
     would keep whatever mode it had. */
  chmodSync(temp, 0o600);
  /* Atomic replace. rename(2) over an existing path is a single operation on
     POSIX, so a reader either sees the whole old file or the whole new one, and
     a crash here cannot produce a truncated credential. */
  renameSync(temp, CREDENTIALS_PATH);
  /* Belt and braces on the directory too — it may predate this version and have
     been created with a laxer mode. */
  try {
    chmodSync(dirname(CREDENTIALS_PATH), 0o700);
  } catch {
    /* A directory we cannot chmod is one somebody else owns, which is a problem
       the write above would already have failed on. Nothing to add. */
  }
}

export function clearCredentials(): void {
  rmSync(CREDENTIALS_PATH, { force: true });
}

/** Everything about the current login that is safe to print. Note the absence of
 *  `token`; that is the point of the function. */
export function describeCredentials(credentials: Credentials) {
  const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : null;
  return {
    account: credentials.account?.email ?? credentials.account?.name ?? "unknown",
    baseUrl: credentials.baseUrl,
    loggedInAt: credentials.loggedInAt,
    expiresAt: credentials.expiresAt,
    expired: expiresAt ? expiresAt.getTime() <= Date.now() : false,
  };
}
