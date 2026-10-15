import { z } from "zod";
import { request } from "../api.js";
import { destructiveTool, readTool, writeTool, type Tool } from "./types.js";

/* Scheduling, and the automation planner.
 *
 * This is the group that reaches the outside world. Everything else here either
 * reads, or writes something that stays inside the account; these tools put
 * content on a real TikTok, Instagram or YouTube channel with the user's name on
 * it, and a published post cannot be recalled from this API.
 *
 * The descriptions say so plainly rather than relying on the client to guess.
 * They also say the two mechanical things that are easy to get wrong and produce
 * a confusing failure: a publish time must be a couple of minutes into the future
 * (the publisher cron claims anything due within 60 seconds, so a post scheduled
 * for "now" races it), and a post fanned out across several accounts is a group
 * that has to be moved or cancelled together, never split.
 */

const workspaceArg = {
  workspaceId: z.string().optional().describe("Workspace to act in. Defaults to the active one."),
};

export const publishingTools: Tool[] = [
  writeTool({
    name: "schedule_generation",
    title: "Schedule a generated post",
    description:
      "Schedule an already-generated video or image to publish to connected social accounts. THIS PUBLISHES PUBLICLY at the time given — confirm with the user before calling. The generation must have finished. publishAt must be at least ~2 minutes in the future. Selecting several accounts fans out to all of them as one group.",
    schema: {
      ...workspaceArg,
      generationId: z
        .string()
        .describe("Id of a finished generation, from list_video_jobs or list_image_generations."),
      accountIds: z
        .array(z.string())
        .min(1)
        .describe("Connected account ids from list_connected_accounts."),
      publishAt: z
        .string()
        .describe("ISO 8601 timestamp, at least ~2 minutes from now. Include the offset or use Z."),
      caption: z.string().optional().describe("Caption text. Consider write_post_copy for this."),
    },
    run: (args) =>
      request("/api/ai-studio/post", {
        method: "POST",
        body: {
          id: args.generationId,
          accountIds: args.accountIds,
          publishAt: args.publishAt,
          caption: args.caption ?? "",
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "reschedule_posts",
    title: "Move a scheduled post",
    description:
      "Change when a scheduled post publishes. Pass EVERY id in the group — a post sent to three accounts is three rows sharing one time, and they must move together; a partial list is refused rather than splitting them. Only works while the posts are still 'scheduled', and the new time must be a few minutes out.",
    schema: {
      ...workspaceArg,
      postIds: z
        .array(z.string())
        .min(1)
        .describe("Every post id in the group, from list_posts (same reel id and publish time)."),
      publishAt: z.string().describe("New ISO 8601 timestamp, at least ~5 minutes from now."),
    },
    run: (args) =>
      request("/api/posts", {
        method: "PATCH",
        body: { ids: args.postIds, publishAt: args.publishAt },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  destructiveTool({
    name: "cancel_posts",
    title: "Cancel scheduled posts",
    description:
      "Cancel posts that have not published yet. Anything already published or mid-publish is silently skipped — this cannot unpublish. Pass every id in a fanned-out group to cancel it whole.",
    schema: {
      ...workspaceArg,
      postIds: z.array(z.string()).min(1).describe("Post ids from list_posts."),
    },
    run: (args) =>
      request("/api/posts", {
        method: "DELETE",
        query: { ids: (args.postIds as string[]).join(",") },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_automations",
    title: "List automations",
    description:
      "Automations in this workspace. An automation is a planned run of posts across a date range — it generates a lineup of content, which a human approves, and then publishes on a schedule.",
    schema: workspaceArg,
    run: (args) =>
      request("/api/automations", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  readTool({
    name: "get_automation",
    title: "Get an automation",
    description:
      "One automation in full, including its planned items and their individual states.",
    schema: {
      ...workspaceArg,
      automationId: z.string().describe("Automation id from list_automations."),
    },
    run: (args) =>
      request(`/api/automations/${encodeURIComponent(String(args.automationId))}`, {
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "create_automation",
    title: "Create an automation",
    description:
      "Plan a run of posts across a date range. This creates the plan and reserves allowance; it does not publish anything until publish_automation is called on it. The daily slot ceiling comes from the plan — read automationSlotsPerDay from whoami before choosing postTimes.",
    schema: {
      ...workspaceArg,
      name: z.string().optional().describe("Label for the automation."),
      startDate: z.string().describe("First day, as YYYY-MM-DD."),
      endDate: z.string().describe("Last day, as YYYY-MM-DD."),
      postTimes: z
        .array(z.string())
        .min(1)
        .describe(
          "Times of day to post, as HH:MM in the timezone below. Count must not exceed automationSlotsPerDay from whoami.",
        ),
      timezone: z
        .string()
        .optional()
        .describe("IANA time zone the postTimes are in, e.g. 'Asia/Kolkata'."),
      accountIds: z
        .array(z.string())
        .min(1)
        .describe("Connected account ids to publish to, from list_connected_accounts."),
      targetPosts: z.number().int().min(1).optional().describe("Total posts to plan."),
      reelsPct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Percentage of the lineup that should be reels rather than slideshows."),
    },
    run: (args) => {
      const { workspaceId, ...body } = args;
      return request("/api/automations", {
        method: "POST",
        body,
        workspaceId: (workspaceId as string) ?? null,
      });
    },
  }),

  writeTool({
    name: "update_automation",
    title: "Update an automation",
    description:
      "Change an automation's name, schedule or target accounts. Items already published are not affected.",
    schema: {
      ...workspaceArg,
      automationId: z.string().describe("Automation id from list_automations."),
      name: z.string().optional().describe("New label."),
      startDate: z.string().optional().describe("New first day, YYYY-MM-DD."),
      endDate: z.string().optional().describe("New last day, YYYY-MM-DD."),
      postTimes: z.array(z.string()).optional().describe("New times of day, HH:MM."),
      accountIds: z.array(z.string()).optional().describe("New target account ids."),
    },
    run: (args) => {
      const { workspaceId, automationId, ...patch } = args;
      const body = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to change — pass at least one field.");
      }
      return request(`/api/automations/${encodeURIComponent(String(automationId))}`, {
        method: "PATCH",
        body,
        workspaceId: (workspaceId as string) ?? null,
      });
    },
  }),

  writeTool({
    name: "publish_automation",
    title: "Approve and publish an automation",
    description:
      "Approve an automation's lineup and commit it to the publishing schedule. THIS IS THE POINT OF NO RETURN — from here the posts go out to real accounts on their planned times without further confirmation. Always show the user the lineup from get_automation and get explicit approval before calling this.",
    schema: {
      ...workspaceArg,
      automationId: z.string().describe("Automation id from list_automations."),
    },
    run: (args) =>
      request(`/api/automations/${encodeURIComponent(String(args.automationId))}/publish`, {
        method: "POST",
        body: {},
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  destructiveTool({
    name: "delete_automation",
    title: "Delete an automation",
    description:
      "Delete an automation and cancel everything it still has scheduled. Posts it already published stay up. No undo.",
    schema: {
      ...workspaceArg,
      automationId: z.string().describe("Automation id from list_automations."),
    },
    run: (args) =>
      request(`/api/automations/${encodeURIComponent(String(args.automationId))}`, {
        method: "DELETE",
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),
];
