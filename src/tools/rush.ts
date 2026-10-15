import { z } from "zod";
import { request } from "../api.js";
import { readTool, writeTool, type Tool } from "./types.js";

/* Rush — the swipe deck.
 *
 * Cards are dealt from the daily reel allowance, and a card in hand is already
 * counted against it: `reelsLeftToday` in whoami is what is unspent PLUS what has
 * been dealt and not yet decided. So pulling a big feed is not free browsing, it
 * is spending the day's deck, and leaving cards unresolved holds allowance that
 * nothing can give back until the day rolls over.
 *
 * Which is why get_rush_feed says to ask first and resolve_rush_item exists as a
 * separate tool: dealing and deciding are two halves of one transaction, and an
 * agent that only ever does the first half quietly burns somebody's day.
 */

const workspaceArg = {
  workspaceId: z.string().optional().describe("Workspace to act in. Defaults to the active one."),
};

/* The deck's verdict vocabulary is NOT this tool's vocabulary. /api/rush/resolve
 * accepts only 'ship' | 'stage' | 'pass' (RushResolutionDecision), so sending
 * 'keep' straight through failed resolutionDecision(), arrived as a null decision
 * and came back 400 "itemId and decision are required" — an error that names the
 * one argument that was actually fine, which is a long way to debug. 'keep' maps to
 * 'stage', not 'ship': it closes the card and leaves the reel in the lineup, and
 * the route lets a later save/schedule promote a stage to ship but never the
 * reverse. Publishing is a separate, louder decision than keeping. */
const RESOLVE_DECISION = { keep: "stage", skip: "pass" } as const;

/* One picked card, in the shape get_rush_feed already handed over.
 *
 * Deliberately the card's own field names — videoId, slideshowId, postTitle,
 * postDescription, hashtags, postCopy, slides — so an agent forwards what it was
 * given instead of translating it. The two that are not on the card are `caption`
 * (the card offers `captions`, an array, because a card may propose more than one
 * on-screen line: send the one you chose) and `spec`. */
const lineupItem = z.object({
  kind: z
    .enum(["reel", "slideshow"])
    .optional()
    .describe("Copy the card's `kind`. Defaults to 'reel'."),
  rushItemId: z
    .string()
    .optional()
    .describe(
      "The card's `rushItemId`. Send it: it marks the post as already paid for out of the deck, and it is what lets resolve_rush_item close this card afterwards.",
    ),
  videoId: z.string().optional().describe("The card's `videoId`. Required when kind is 'reel'."),
  slideshowId: z
    .string()
    .optional()
    .describe("The card's `slideshowId`. Required when kind is 'slideshow'."),
  caption: z
    .string()
    .optional()
    .describe("Text burned onto the video. Usually the card's `captions[0]`. Omit for no caption."),
  title: z.string().optional().describe("Internal label for the run. Not published."),
  postTitle: z.string().optional().describe("The card's `postTitle`."),
  postDescription: z.string().optional().describe("The card's `postDescription`."),
  hashtags: z.array(z.string()).optional().describe("The card's `hashtags`, without the '#'."),
  postCopy: z
    .unknown()
    .optional()
    .describe(
      "The card's `postCopy` object, forwarded unchanged. Worth sending — it carries the per-platform titles and bodies, so TikTok, Instagram and YouTube each get copy written for them rather than one shared string.",
    ),
  slides: z
    .array(
      z.object({
        position: z.number().describe("1-based, and must match the card's slide positions."),
        headline: z.string().optional(),
        body: z.string().optional(),
      }),
    )
    .optional()
    .describe(
      "Slideshow text only, keyed by position; the images come from the card itself. Send the card's `slides` as-is, or the same positions with edited text.",
    ),
  spec: z
    .object({
      x: z.number().describe("Left edge of the caption box, 0-1 of frame width."),
      y: z.number().describe("Vertical centre of the box, 0-1 of frame height."),
      w: z.number().describe("Box width, 0-1 of frame width. Must be > 0."),
      size: z.number().describe("Font size in px on a 1080-wide canvas."),
      outline: z.number().describe("Outline thickness in px. 0 for none."),
      color: z.string().describe("Caption fill, e.g. '#ffffff'."),
    })
    .optional()
    .describe(
      "Where the caption sits. OMIT THIS unless the user asked for a specific placement — left out, it gets the same position a Rush card uses when nobody drags the box. Sent half-filled it is refused, because a partial box means a caller that tried to place the caption and got it wrong.",
    ),
});

export const rushTools: Tool[] = [
  readTool({
    name: "get_rush_prefs",
    title: "Rush preferences",
    description:
      "What the Rush deck is currently tuned to — the content mix and the categories it draws from.",
    schema: workspaceArg,
    run: (args) => request("/api/rush/prefs", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  writeTool({
    name: "get_rush_feed",
    title: "Deal Rush cards",
    description:
      "Deal the next cards from the Rush deck. NOT a plain read: cards dealt here are counted against the account's daily reel allowance as soon as they are in hand, and stay counted until each one is kept or skipped with resolve_rush_item. Ask the user before dealing a large batch, and resolve what you deal.",
    schema: {
      ...workspaceArg,
      cursor: z.number().int().min(0).optional().describe("Paging cursor. Start at 0."),
      mode: z
        .enum(["fresh", "repeat"])
        .optional()
        .describe("'fresh' for unseen cards, 'repeat' to revisit. Defaults to fresh."),
    },
    run: (args) =>
      request("/api/rush/feed", {
        method: "POST",
        body: {
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "resolve_rush_item",
    title: "Keep or skip a Rush card",
    description:
      "Decide a card that has been dealt — keep it, which turns it into a reel, or skip it, which returns its hold on the daily allowance. Every card from get_rush_feed should end up here.",
    schema: {
      ...workspaceArg,
      itemId: z.string().describe("Card id from get_rush_feed."),
      decision: z
        .enum(["keep", "skip"])
        .describe("'keep' makes a reel from it; 'skip' discards it and frees the hold."),
    },
    run: (args) =>
      request("/api/rush/resolve", {
        method: "POST",
        body: { itemId: args.itemId, decision: RESOLVE_DECISION[args.decision as keyof typeof RESOLVE_DECISION] },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "schedule_rush_lineup",
    title: "Schedule picked Rush cards",
    description:
      "Turn Rush cards you have already dealt into a dated plan. This is the only way to get a Rush pick onto a calendar — resolve_rush_item records a verdict but builds nothing, and create_automation invents its own content instead of taking yours.\n\n" +
      "PUBLISHES NOTHING. It returns a draft automation: no video is rendered and no post exists until publish_automation is called on the id it hands back. That makes this safe to call before showing the user anything.\n\n" +
      "The whole flow, in order:\n" +
      "  1. get_rush_feed — deal cards.\n" +
      "  2. schedule_rush_lineup — send the ones you want (this tool). Do this BEFORE step 3: if the plan is refused, the deck is left exactly as it was, whereas resolving first would close cards for a run that never existed.\n" +
      "  3. resolve_rush_item with 'keep' for each card you sent, and 'skip' for the rest, to clear the hand.\n" +
      "  4. get_automation — read the lineup back and show the user the dates and copy.\n" +
      "  5. publish_automation — only after the user has explicitly approved. This is irreversible.\n\n" +
      "Dates are worked out for you: it spreads the items from startDate over postTimes and returns the exact instant each one landed on, so you never compute a timestamp yourself.\n\n" +
      "ALWAYS PASS `timezone`. It is the one default that will embarrass you. Omitted, the zone saved on the account is used, and accounts often have none saved — which falls back to UTC, so an evening slot for a user in Asia/Kolkata is planned at half past one in the morning. Pass the user's IANA zone every time unless they actually want UTC.\n\n" +
      "startDate defaults to tomorrow, which is usually right. postTimes defaults to a spread that fits the items into the days available; it is a reasonable shape but it knows nothing about when this audience is awake, so prefer the times the workspace already posts at — list_posts shows the existing cadence. Note the plan-window check is on startDate only, so a long run can still spread past the date the plan is paid through.\n\n" +
      "Refusals worth knowing before you call: a lineup may hold at most 200 items; postTimes cannot be longer than the plan's reels-per-day (read reelsPerDay from whoami); and a run cannot start after the date the plan is paid through, so check periodEnd in whoami if the user wants something far out.",
    schema: {
      ...workspaceArg,
      items: z
        .array(lineupItem)
        .min(1)
        .max(200)
        .describe("The picked cards, in the order you want them posted."),
      accountIds: z
        .array(z.string())
        .min(1)
        .describe(
          "Connected account ids from list_connected_accounts. Every item is published to all of them. Required here even though the plan itself would accept none, because a lineup with no accounts cannot be published and there is nothing useful to do with it.",
        ),
      startDate: z
        .string()
        .optional()
        .describe("First day, YYYY-MM-DD, in the account's scheduling zone. Defaults to tomorrow."),
      postTimes: z
        .array(z.string())
        .optional()
        .describe(
          "Times of day, HH:MM, applied to every day of the run. Deduplicated and sorted. Defaults to a spread that fits.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA zone the postTimes are read in, e.g. 'Asia/Kolkata'. Send it. A zone saved on the account takes precedence (so a trip cannot silently re-time somebody's calendar), but when none is saved this is all there is, and omitting it means UTC.",
        ),
      name: z.string().optional().describe("Label for the run. Defaults to a dated one."),
    },
    run: (args) =>
      request("/api/automations/lineup", {
        method: "POST",
        body: {
          items: args.items,
          accountIds: args.accountIds,
          ...(args.startDate === undefined ? {} : { startDate: args.startDate }),
          ...(args.postTimes === undefined ? {} : { postTimes: args.postTimes }),
          ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
          ...(args.name === undefined ? {} : { name: args.name }),
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),
];
