import { accountTools } from "./account.js";
import { insightTools, notificationWriteTools } from "./insights.js";
import { libraryTools } from "./library.js";
import { publishingTools } from "./publishing.js";
import { rushTools } from "./rush.js";
import { studioTools } from "./studio.js";
import type { Tool } from "./types.js";

/* Everything this server exposes, in the order a session tends to need it:
 * establish who and where first, then look, then make, then publish.
 *
 * The order is not cosmetic. Most clients list tools in the order they are
 * registered and models read that list top to bottom, so putting whoami and
 * list_workspaces first is the cheapest available nudge toward finding out which
 * brand is being worked on before generating anything for it.
 *
 * ONE THING IS DELIBERATELY ABSENT: buying. There is no tool to start a checkout,
 * change plan, buy credits or edit a payment method, and /api/billing is
 * unreachable from here. Not because the API would refuse — it would happily
 * accept the call — but because "the agent bought something" is a class of
 * mistake with no undo and no ceiling, and the plan limits an agent runs into are
 * exactly the moment it would be most tempted to spend its way past them. Buying
 * stays a thing a person does in a browser.
 */

export const ALL_TOOLS: Tool[] = [
  ...accountTools,
  ...insightTools,
  ...notificationWriteTools,
  ...libraryTools,
  ...studioTools,
  ...publishingTools,
  ...rushTools,
];

export type { Tool };
