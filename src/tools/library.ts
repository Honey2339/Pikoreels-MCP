import { z } from "zod";
import { request } from "../api.js";
import { destructiveTool, readTool, writeTool, type Tool } from "./types.js";

/* The media library.
 *
 * One capability is deliberately missing: there is no upload tool. Uploading goes
 * through a signed direct-to-R2 PUT followed by a publish call, and the file has
 * to exist as bytes somewhere the browser can read — an MCP client passing a path
 * would be asking this process to read arbitrary files off the user's disk on a
 * model's say-so, which is a much larger trust decision than "let an agent see my
 * reels". Uploading stays in the browser; everything you can do with what is
 * already there is here.
 */

const workspaceArg = {
  workspaceId: z.string().optional().describe("Workspace to act in. Defaults to the active one."),
};

export const libraryTools: Tool[] = [
  readTool({
    name: "list_library_uploads",
    title: "List library media",
    description:
      "Media in the workspace library — uploaded clips and images, with ids, titles, folders and storage keys. The ids here are what reference-taking generation tools expect.",
    schema: workspaceArg,
    run: (args) =>
      request("/api/library/uploads", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  readTool({
    name: "list_folders",
    title: "List folders",
    description: "Folders the workspace's library media is organised into.",
    schema: workspaceArg,
    run: (args) => request("/api/folders", { workspaceId: (args.workspaceId as string) ?? null }),
  }),

  writeTool({
    name: "create_folder",
    title: "Create folder",
    description: "Create a library folder to organise media into.",
    schema: { ...workspaceArg, name: z.string().min(1).describe("Folder name.") },
    run: (args) =>
      request("/api/folders", {
        method: "POST",
        body: { name: args.name },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "move_uploads_to_folder",
    title: "Move media into a folder",
    description:
      "Move library media into a folder, or out of every folder by passing folderId as null. Moves are metadata only — nothing is re-uploaded and no file changes.",
    schema: {
      ...workspaceArg,
      uploadIds: z.array(z.string()).min(1).describe("Upload ids from list_library_uploads."),
      folderId: z
        .string()
        .nullable()
        .describe("Destination folder id, or null to move them out of any folder."),
    },
    run: (args) =>
      request("/api/library/uploads", {
        method: "PATCH",
        body: { uploadIds: args.uploadIds, folderId: args.folderId ?? null },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  destructiveTool({
    name: "delete_upload",
    title: "Delete library media",
    description:
      "Permanently delete one piece of library media and free its storage. Posts already published with it are unaffected, but anything still referencing it will lose the file. No undo.",
    schema: {
      ...workspaceArg,
      uploadId: z.string().describe("Upload id from list_library_uploads."),
    },
    run: (args) =>
      request("/api/library/uploads", {
        method: "DELETE",
        query: { id: String(args.uploadId) },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),
];
