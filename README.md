# PikoReels MCP

An MCP server for PikoReels. Sign in once from a terminal, and Claude Code,
Claude Desktop, Codex or any other MCP client can read your workspace, generate
content, and schedule posts.

## How the login works

There is no API key to copy. The server uses the OAuth device grant (RFC 8628):

1. You run `piko-mcp login`.
2. It prints an 8-character code and opens `app.pikoreels.com/device`.
3. You sign in with Google if you aren't already, check the code matches, and
   press **Connect**.
4. The terminal picks up a session token and writes it to
   `~/.pikoreels/credentials.json` with mode `0600`.

The token is an ordinary PikoReels session, so it shows up in **Settings →
Security** as *PikoReels MCP* and you can sign it out from there at any time.
Nothing secret is ever typed into the terminal, and the code you approve in the
browser is useless to anyone who doesn't already hold the matching device code.

## Install

```bash
npx -y @pikoreels/mcp login
```

That signs you in and caches the credential. Nothing to clone, nothing to build.

To point at a local dev server instead of production:

```bash
PIKOREELS_URL=http://localhost:3000 npx -y @pikoreels/mcp login
```

## Connect a client

The server runs on stdio and takes no arguments.

### Claude Code

```bash
claude mcp add pikoreels -- npx -y @pikoreels/mcp
```

### Codex

```bash
codex mcp add pikoreels -- npx -y @pikoreels/mcp
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pikoreels": {
      "command": "npx",
      "args": ["-y", "@pikoreels/mcp"]
    }
  }
}
```

Add an `"env"` block with `PIKOREELS_URL` if you're pointing at a non-production
deployment. The client must be launched with the same `PIKOREELS_HOME` you logged
in under — if you didn't set one, the default works everywhere.

## What it can do

46 tools, roughly:

| Area | Tools |
| --- | --- |
| Account | `whoami`, workspaces (list / switch / create / rename / delete) |
| Brand | `get_brand`, `update_brand_voice`, `scrape_website` |
| Connections | `list_connected_accounts`, `disconnect_account` |
| Insights | `get_dashboard`, `get_analytics`, `list_posts`, `get_post_analytics`, notifications |
| Library | uploads, folders, moving and deleting media |
| AI Studio | `list_studio_models`, `generate_image`, `generate_video`, slideshows, `write_post_copy` |
| Publishing | `schedule_generation`, `reschedule_posts`, `cancel_posts` |
| Automations | list / get / create / update / publish / delete |
| Rush | `get_rush_feed`, `resolve_rush_item`, `get_rush_prefs` |

### What it deliberately cannot do

**Buying.** There is no tool for checkout, changing plan, purchasing credits, or
editing a payment method, and `/api/billing` is unreachable from here. Plan
limits are exactly the moment an agent would be most tempted to spend past them,
and that mistake has no undo. Buying stays something a person does in a browser.

**Uploading files.** Media upload needs a signed direct-to-R2 PUT and a file on
disk; letting a model name arbitrary paths for this process to read is a much
bigger trust decision than reading your reels. Upload in the browser.

**Connecting social accounts.** Those need an interactive OAuth round trip.

## Things worth knowing

- **Generation costs real money.** Credits are US cents of provider spend. Video
  runs 5–53 credits *per second*, so a 5-second clip is 25–265 credits depending
  on the tier. Charges land when a job is accepted, not when it succeeds. The
  tool descriptions say this, and `list_studio_models` gives the model the prices
  to choose with.
- **Everything is workspace-scoped.** Content, connected accounts and analytics
  all belong to a workspace, not the account. `use_workspace` sets the default
  for a session; any tool also takes a one-off `workspaceId`.
- **Publishing is real and irreversible.** `schedule_generation` and
  `publish_automation` put content on live public channels. Nothing here can
  unpublish.
- **Metrics lag.** They come from scheduled snapshots, so a post from ten minutes
  ago showing zero views is expected.

## Commands

```
piko-mcp            Run the server on stdio (what a client invokes)
piko-mcp login      Sign in via the browser
piko-mcp status     Show the current login
piko-mcp logout     Forget the local credential
```

`logout` only clears the local file. To kill the session server-side, revoke it
in **Settings → Security**.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PIKOREELS_URL` | `https://app.pikoreels.com` | Deployment to talk to |
| `PIKOREELS_HOME` | `~/.pikoreels` | Where the credential lives. Set it to keep a second account or a staging login separate. |

## Server-side requirements

This talks to the main Next app, which needs:

- `bearer()` and `deviceAuthorization()` on the Better Auth config (`lib/auth.ts`)
- the `deviceCode` table (`scripts/schema.sql`, applied by `npm run migrate`)
- the `/device` approval page (`app/device/`)
- `GET /api/ai-studio/models`, the generation catalogue

No other route needed changing: the bearer plugin rewrites an
`Authorization: Bearer` header into a session cookie before anything downstream
looks, so all ~80 existing routes accept the token as-is.

## Development

```bash
cd mcp
npm install
npm run build     # tsc
npm run dev       # tsc --watch
npm test          # spawns the server over a real stdio pipe and drives it
```

To run a local checkout instead of the published package, point the client at
`node /absolute/path/to/mcp/dist/index.js`.

The tests need no login — they check the handshake, that every tool registers
with a usable schema, that the destructive ones are annotated so clients prompt
for them, and that no billing tool has crept in.
