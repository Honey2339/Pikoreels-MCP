import type { ZodRawShape } from "zod";

/* What a tool is, here.
 *
 * The MCP SDK wants a name, a schema and a callback. This adds nothing to that
 * except a shape that can be written as a table, because the alternative — forty
 * calls to server.registerTool, each with its own inline handler — buries the
 * one thing worth reading (which endpoint, what arguments) under ceremony.
 * src/server.ts walks this list and does the registration.
 *
 * `annotations` is not decoration. A client uses readOnlyHint to decide what may
 * run without asking, and destructiveHint to decide what must be confirmed;
 * Claude Code and Codex both surface the difference to the user. Getting them
 * wrong is how a tool that deletes a workspace ends up auto-approved, so every
 * entry states both rather than leaning on a default.
 */

export type Tool = {
  /** snake_case, matching the convention every other MCP server uses. */
  name: string;
  /** Human title for a picker. Short. */
  title: string;
  /**
   * What it does and when to reach for it, written for a model with no other
   * knowledge of this product. Worth more care than the code: this string is the
   * entire basis on which the tool gets chosen or skipped.
   */
  description: string;
  schema?: ZodRawShape;
  annotations: {
    /** True when the call cannot change anything. */
    readOnlyHint: boolean;
    /** True when it can destroy or overwrite something a user would miss. */
    destructiveHint?: boolean;
    /** True when calling it twice is the same as calling it once. */
    idempotentHint?: boolean;
  };
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Sugar for the common case: a read that changes nothing. */
export function readTool(tool: Omit<Tool, "annotations">): Tool {
  return { ...tool, annotations: { readOnlyHint: true, idempotentHint: true } };
}

/** Sugar for a write that creates or updates but destroys nothing. */
export function writeTool(tool: Omit<Tool, "annotations">): Tool {
  return { ...tool, annotations: { readOnlyHint: false, destructiveHint: false } };
}

/** Sugar for a write that removes something. Clients are expected to confirm. */
export function destructiveTool(tool: Omit<Tool, "annotations">): Tool {
  return { ...tool, annotations: { readOnlyHint: false, destructiveHint: true } };
}
