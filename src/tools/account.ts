import { z } from "zod";
import { getActiveWorkspace, request, setActiveWorkspace } from "../api.js";
import { destructiveTool, readTool, writeTool, type Tool } from "./types.js";

/* Who the caller is, which workspace they are working in, and what the brand
 * sounds like.
 *
 * These are the tools an agent should reach for FIRST and the descriptions say
 * so, because almost every mistake this server can make is a workspace mistake:
 * content is per-workspace, connected accounts are per-workspace, and an agency
 * account with four clients will happily generate a reel for the wrong one if
 * nobody asked which. `whoami` and `list_workspaces` are cheap; guessing is not.
 */

const workspaceArg = {
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Workspace to act in. Defaults to the one set by use_workspace, or the account's first workspace. Pass this to act on a different workspace for one call only.",
    ),
};

export const accountTools: Tool[] = [
  readTool({
    name: "whoami",
    title: "Account overview",
    description:
      "The signed-in account, its plan, and everything it has left: AI Studio credits, reels today and this month, automated posts, workspace slots and storage. Call this before any generation — the limits here are enforced server-side, so a job that exceeds them fails rather than queues. Also names the workspace the other tools will act on by default.",
    schema: workspaceArg,
    run: async (args) => {
      const plan = await request("/api/me/plan", {
        workspaceId: (args.workspaceId as string) ?? null,
      });
      return { ...(plan as object), activeWorkspaceOverride: getActiveWorkspace() };
    },
  }),

  readTool({
    name: "list_workspaces",
    title: "List workspaces",
    description:
      "Every workspace on the account, with the active one marked and the plan's workspace allowance. A workspace is a separate brand: its own content, its own connected social accounts, its own analytics. Check this before acting when the account might have more than one.",
    run: () => request("/api/workspaces"),
  }),

  writeTool({
    name: "use_workspace",
    title: "Switch workspace",
    description:
      "Set the workspace every later tool call acts on, for the rest of this session. Takes a workspace id from list_workspaces. This only changes where THIS MCP connection points — it does not move the workspace switcher in the user's browser.",
    schema: {
      workspaceId: z.string().describe("Workspace id from list_workspaces."),
    },
    run: async (args) => {
      const id = String(args.workspaceId);
      /* Verified against the server rather than trusted, so a typo is a clear
         error now instead of every later call silently landing in the default
         workspace — which is the failure mode that gets content generated for
         the wrong client. */
      const overview = (await request("/api/workspaces", { workspaceId: id })) as {
        workspaces?: { id: string; name: string }[];
      };
      const match = overview.workspaces?.find((workspace) => workspace.id === id);
      if (!match) {
        throw new Error(
          `No workspace with id ${id} on this account. Call list_workspaces to see the ids.`,
        );
      }
      setActiveWorkspace(id);
      return { active: match, note: "Later tool calls will use this workspace." };
    },
  }),

  writeTool({
    name: "create_workspace",
    title: "Create workspace",
    description:
      "Add a workspace — a separate brand with its own content and connected accounts. Fails with a plan-limit message when the account is at its allowance. Does not switch to it; call use_workspace afterwards.",
    schema: { name: z.string().min(1).describe("Display name for the new workspace.") },
    run: (args) => request("/api/workspaces", { method: "POST", body: { name: args.name } }),
  }),

  writeTool({
    name: "rename_workspace",
    title: "Rename workspace",
    description:
      "Rename a workspace. Renaming also marks the name as human-chosen, which stops a later brand scrape from overwriting it.",
    schema: {
      workspaceId: z.string().describe("Workspace id from list_workspaces."),
      name: z.string().min(1).describe("New display name."),
    },
    run: (args) =>
      request(`/api/workspaces/${encodeURIComponent(String(args.workspaceId))}`, {
        method: "PATCH",
        body: { name: args.name },
      }),
  }),

  destructiveTool({
    name: "delete_workspace",
    title: "Delete workspace",
    description:
      "PERMANENTLY delete a workspace and everything in it — generated reels, library uploads, scheduled posts, analytics history and connected social accounts. There is no undo and no export. Refuses to delete the account's last workspace. Always confirm the exact workspace name with the user before calling this.",
    schema: { workspaceId: z.string().describe("Workspace id from list_workspaces.") },
    run: (args) =>
      request(`/api/workspaces/${encodeURIComponent(String(args.workspaceId))}`, {
        method: "DELETE",
      }),
  }),

  readTool({
    name: "get_brand",
    title: "Brand profile",
    description:
      "The workspace's brand: website, description, and the voice settings (brand name, @handle, niche, default platform, whether posts mention the brand). This is what the caption writer and the UGC prompt builder draw on, so read it before writing copy so the result sounds like the brand rather than like a generic ad.",
    schema: workspaceArg,
    run: async (args) => {
      const workspaceId = (args.workspaceId as string) ?? null;
      /* Two endpoints because they are two records — the scraped brand and the
         voice a human set. Fetched together because no caller has ever wanted
         one without the other, and separately would be two round trips to a
         database that is not nearby. */
      const [brand, voice] = await Promise.all([
        request("/api/brand", { workspaceId }),
        request("/api/brand/voice", { workspaceId }),
      ]);
      return { brand, voice };
    },
  }),

  writeTool({
    name: "update_brand_voice",
    title: "Update brand voice",
    description:
      "Change how captions sound. Only the fields you send are changed; the rest are left alone. The @handle is globally unique — if it is taken the call fails with a suggestion you can offer the user.",
    schema: {
      ...workspaceArg,
      brandName: z.string().optional().describe("Name captions should call the brand."),
      brandHandle: z
        .string()
        .optional()
        .describe("Public @handle, without the @. Globally unique across all accounts."),
      niche: z.string().optional().describe("What the brand sells or is about."),
      defaultPlatform: z
        .enum(["tiktok", "instagram", "youtube"])
        .optional()
        .describe("Platform captions are written for by default."),
      mentionBrand: z
        .boolean()
        .optional()
        .describe("Whether captions should name the brand at all."),
    },
    run: (args) => {
      const { workspaceId, ...patch } = args;
      /* Undefined keys are dropped rather than sent as null, because null is
         meaningful to this endpoint: it CLEARS a field. Sending the absent ones
         would blank a brand name every time somebody changed the niche. */
      const body = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change — pass at least one field.");
      }
      return request("/api/brand/voice", {
        method: "PUT",
        body,
        workspaceId: (workspaceId as string) ?? null,
      });
    },
  }),

  writeTool({
    name: "scrape_website",
    title: "Read a website",
    description:
      "Fetch and summarise a website so the brand can be described from it. Use this when the user gives a URL and you need to know what the business actually is before writing copy or setting the brand. Returns the extracted content; it does not save anything.",
    schema: { url: z.string().url().describe("Full URL including https://.") },
    run: (args) => request("/api/scrape", { method: "POST", body: { url: args.url } }),
  }),

  readTool({
    name: "list_connected_accounts",
    title: "Connected social accounts",
    description:
      "The TikTok, Instagram and YouTube accounts connected to this workspace, with the ids that scheduling tools need. Connections are per workspace. New accounts can only be connected in the browser — this cannot start an OAuth flow.",
    schema: workspaceArg,
    run: (args) =>
      request("/api/accounts", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  destructiveTool({
    name: "disconnect_account",
    title: "Disconnect a social account",
    description:
      "Disconnect a social account from this workspace and revoke the app's access with the platform. Already-published posts stay; anything still scheduled to it will fail. Reconnecting requires the user to go through OAuth in the browser again.",
    schema: {
      ...workspaceArg,
      accountId: z.string().describe("Account id from list_connected_accounts."),
    },
    run: (args) =>
      request("/api/accounts", {
        method: "DELETE",
        query: { id: String(args.accountId) },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),
];
