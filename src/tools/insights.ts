import { z } from "zod";
import { request } from "../api.js";
import { readTool, type Tool } from "./types.js";

/* Reading the numbers.
 *
 * Two things about this group are worth knowing before using it. The metrics are
 * SNAPSHOT-BACKED — a separate publisher process captures them on a schedule, so
 * a post published minutes ago legitimately shows zero views and that is not a
 * bug to chase. And the time zone matters: "views today" and "best hour to post"
 * are cut on a calendar, so passing the user's zone is the difference between an
 * answer about their day and an answer about UTC's.
 */

const workspaceArg = {
  workspaceId: z.string().optional().describe("Workspace to read. Defaults to the active one."),
};

const tzArg = {
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA time zone, e.g. 'Asia/Kolkata'. Daily buckets and posting-hour analysis are cut on this clock. Defaults to UTC, which is rarely what the user means — pass their zone when you know it.",
    ),
};

export const insightTools: Tool[] = [
  readTool({
    name: "get_dashboard",
    title: "Dashboard overview",
    description:
      "The workspace at a glance: lifetime views and likes, published count, the last five reels with their status, and what is scheduled next. The best first call for 'how am I doing'. Sections degrade independently — a section marked 'unavailable' failed on its own and the rest of the payload is still good.",
    schema: { ...workspaceArg, ...tzArg },
    run: (args) =>
      request("/api/dashboard", {
        query: { tz: args.timezone as string },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "get_analytics",
    title: "Analytics",
    description:
      "Deeper performance for the workspace: totals, daily series, per-platform breakdown, top posts and posting-hour patterns. Use this over get_dashboard when the question is about trends, what performed best, or when to post.",
    schema: {
      ...workspaceArg,
      ...tzArg,
      range: z
        .enum(["7d", "30d", "quarter"])
        .optional()
        .describe("Window to report. Defaults to the server's default."),
    },
    run: (args) =>
      request("/api/analytics", {
        query: { tz: args.timezone as string, range: args.range as string },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_posts",
    title: "List posts",
    description:
      "Every post in the workspace — published, scheduled, publishing and failed — with captions, platforms, times, per-post metrics and the account each went to. Capped at the 500 most recent. A post fanned out to several accounts appears as one row per account sharing a reel id and publish time; the scheduling tools treat that group as one unit.",
    schema: workspaceArg,
    run: (args) => request("/api/posts", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  readTool({
    name: "get_post_analytics",
    title: "Per-post metrics",
    description:
      "Metrics for specific posts by id, including how they moved over time where snapshots exist. Use after list_posts when the question is about particular posts rather than the workspace as a whole.",
    schema: {
      ...workspaceArg,
      postIds: z.array(z.string()).min(1).describe("Post ids from list_posts."),
    },
    run: (args) =>
      request("/api/posts/analytics", {
        query: { ids: (args.postIds as string[]).join(",") },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_notifications",
    title: "Notifications",
    description:
      "Recent notifications for the account — finished renders, failed publishes, allowance warnings. Useful for answering 'did anything break' without reading every post.",
    schema: {
      before: z
        .string()
        .optional()
        .describe("ISO timestamp; returns notifications older than this. For paging."),
    },
    run: (args) => request("/api/notifications", { query: { before: args.before as string } }),
  }),
];

export const notificationWriteTools: Tool[] = [
  {
    name: "mark_notifications_read",
    title: "Mark notifications read",
    description:
      "Mark notifications as read — either specific ids, or all of them at once with all=true.",
    schema: {
      ids: z.array(z.string()).optional().describe("Notification ids to mark read."),
      all: z.boolean().optional().describe("Mark every notification read. Ignores ids."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (args) => {
      if (args.all !== true && !(args.ids as string[] | undefined)?.length) {
        throw new Error("Pass either `ids` or `all: true`.");
      }
      return request("/api/notifications", {
        method: "POST",
        body: args.all === true ? { all: true } : { ids: args.ids },
      });
    },
  },
];
