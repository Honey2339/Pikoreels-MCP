import { z } from "zod";
import { request } from "../api.js";
import { destructiveTool, readTool, writeTool, type Tool } from "./types.js";

/* Generation. The only tools here that cost money.
 *
 * Every description in this file names its price in credits, and that is not
 * padding — a credit is a US cent of provider spend, the balance is finite, and
 * the gap between the cheapest and dearest video tier is more than ten to one.
 * A model choosing a model needs to be able to see that, so list_studio_models
 * exists and the generation tools point at it.
 *
 * The server refuses over-budget work rather than queueing it, so a job that
 * would exceed the plan comes back as a 402 with the specific allowance named.
 * That is the intended path: there is no reservation to make here and no
 * client-side estimate that could be more accurate than the server's own.
 */

const workspaceArg = {
  workspaceId: z.string().optional().describe("Workspace to act in. Defaults to the active one."),
};

export const studioTools: Tool[] = [
  readTool({
    name: "list_studio_models",
    title: "Generation models and prices",
    description:
      "The image and video models available, with their tiers, aspect ratios, durations and per-image or per-second credit cost. CALL THIS BEFORE generate_image or generate_video — model and tier ids are not guessable, an unknown one is rejected, and the price difference between tiers is large enough to be worth choosing deliberately.",
    run: () => request("/api/ai-studio/models"),
  }),

  writeTool({
    name: "generate_image",
    title: "Generate images",
    description:
      "Generate images from a prompt. COSTS CREDITS — between roughly 1 and 24 credits per image depending on model and tier, charged whether or not the result is used. Get valid model, tier and aspect values from list_studio_models first, and check the balance with whoami. Returns straight away with the generated images; there is no separate job to poll.",
    schema: {
      ...workspaceArg,
      prompt: z.string().min(1).describe("What to generate. Specific beats clever."),
      model: z.string().describe("Model id from list_studio_models (image.models[].id)."),
      tier: z.string().describe("Tier id from that model's `tiers`. Decides cost and quality."),
      aspect: z
        .string()
        .optional()
        .describe("Aspect ratio from the model's `aspects`. Defaults to 1:1."),
      count: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "How many images. Each one is charged separately, so this multiplies the cost. Capped by the model's maxCount.",
        ),
      references: z
        .array(z.string())
        .optional()
        .describe(
          "Storage keys of library media to use as reference images, from list_library_uploads. Only accepted by models whose `routes` include 'edit', and only files uploaded to this workspace.",
        ),
    },
    run: (args) =>
      request("/api/ai-studio/image", {
        method: "POST",
        body: {
          prompt: args.prompt,
          model: args.model,
          tier: args.tier,
          aspect: args.aspect ?? "1:1",
          count: args.count ?? 1,
          ...(args.references ? { references: args.references } : {}),
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_image_generations",
    title: "Recent image generations",
    description:
      "Recent image generation runs in this workspace, with their prompts, images and the credit balance. Use to find an earlier result rather than paying to regenerate it.",
    schema: {
      ...workspaceArg,
      limit: z.number().int().min(1).optional().describe("How many runs to return."),
    },
    run: (args) =>
      request("/api/ai-studio/image", {
        query: { limit: args.limit as number },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "generate_video",
    title: "Generate a video",
    description:
      "Start a text-to-video generation. COSTS CREDITS — priced per second, from about 5 to 53 credits a second depending on model and tier, so a 5-second clip ranges from ~25 to ~265 credits. Charged when the job is accepted, not when it succeeds. Get valid model, quality, duration and aspect values from list_studio_models, and check the balance with whoami first. Returns a job that renders in the background; poll it with get_video_job.",
    schema: {
      ...workspaceArg,
      prompt: z.string().min(1).describe("What should happen in the shot."),
      model: z.string().describe("Model id from list_studio_models (video.models[].id)."),
      quality: z
        .string()
        .describe("Quality/tier id from that model's `qualities`. The main cost lever."),
      duration: z
        .string()
        .describe("Seconds, as a string, from the model's `durations` — e.g. '5'. Multiplies cost."),
      aspect: z
        .string()
        .optional()
        .describe("Aspect ratio from the model's `aspects`. Defaults to auto."),
      audio: z
        .boolean()
        .optional()
        .describe(
          "Whether to generate sound. Only has an effect on models whose `audio.switchable` is true, and audio usually costs more per second.",
        ),
      useBrand: z
        .boolean()
        .optional()
        .describe(
          "Fold the workspace's brand context into the prompt. Defaults to true; set false for a shot that has nothing to do with the brand.",
        ),
    },
    run: (args) =>
      request("/api/ai-studio/video", {
        method: "POST",
        body: {
          prompt: args.prompt,
          model: args.model,
          quality: args.quality,
          duration: args.duration,
          aspect: args.aspect ?? "auto",
          ...(args.audio === undefined ? {} : { audio: args.audio }),
          ...(args.useBrand === undefined ? {} : { useBrand: args.useBrand }),
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "get_video_job",
    title: "Check a video job",
    description:
      "The current state of one video generation — queued, running, done or failed — and the clip when it has finished. Video takes tens of seconds to minutes; poll every 10-15 seconds rather than in a tight loop.",
    schema: {
      ...workspaceArg,
      jobId: z.string().describe("Job id returned by generate_video."),
    },
    run: (args) =>
      request("/api/ai-studio/video", {
        query: { id: String(args.jobId) },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_video_jobs",
    title: "Recent video jobs",
    description:
      "Recent video generations in this workspace with their status and clips, plus the credit balance. Set completedOnly to skip anything still rendering.",
    schema: {
      ...workspaceArg,
      limit: z.number().int().min(1).optional().describe("How many jobs to return."),
      completedOnly: z
        .boolean()
        .optional()
        .describe("Only return finished jobs. Defaults to false."),
    },
    run: (args) =>
      request("/api/ai-studio/video", {
        query: {
          limit: args.limit as number,
          history: args.completedOnly === true ? "1" : undefined,
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  destructiveTool({
    name: "delete_video_job",
    title: "Delete a video generation",
    description:
      "Delete a generated video and its clip. Credits already spent are NOT refunded — deleting removes the result, not the charge. No undo.",
    schema: {
      ...workspaceArg,
      jobId: z.string().describe("Job id from list_video_jobs."),
    },
    run: (args) =>
      request("/api/ai-studio/video", {
        method: "DELETE",
        query: { id: String(args.jobId) },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_slideshows",
    title: "Recent slideshows",
    description: "Slideshow drafts and finished sets in this workspace.",
    schema: {
      ...workspaceArg,
      limit: z.number().int().min(1).optional().describe("How many to return."),
    },
    run: (args) =>
      request("/api/ai-studio/slideshow", {
        query: { limit: args.limit as number },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "get_slideshow",
    title: "Get a slideshow",
    description: "One slideshow in full — its slides, their copy and their images.",
    schema: {
      ...workspaceArg,
      slideshowId: z.string().describe("Slideshow id from list_slideshows."),
    },
    run: (args) =>
      request(`/api/ai-studio/slideshow/${encodeURIComponent(String(args.slideshowId))}`, {
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  writeTool({
    name: "create_slideshow",
    title: "Create a slideshow",
    description:
      "Build a slideshow from one of the built-in template sets. COSTS CREDITS — the copy is written by an LLM and each slide is a generated image, so cost scales with the slide count. Get image model and tier ids from list_studio_models. Use list_slideshow_templates for valid set ids.",
    schema: {
      ...workspaceArg,
      setId: z.string().describe("Template set id from list_slideshow_templates."),
      slides: z.number().int().min(3).max(12).describe("How many slides to make. 3 to 12."),
      brief: z
        .string()
        .optional()
        .describe("An angle for the copywriter — what this slideshow should argue or show."),
      imageModel: z.string().optional().describe("Image model id from list_studio_models."),
      imageTier: z.string().optional().describe("Tier id for that image model."),
    },
    run: (args) =>
      request("/api/ai-studio/slideshow", {
        method: "POST",
        body: {
          setId: args.setId,
          slides: args.slides,
          ...(args.brief ? { brief: args.brief } : {}),
          ...(args.imageModel ? { imageModel: args.imageModel } : {}),
          ...(args.imageTier ? { imageTier: args.imageTier } : {}),
        },
        workspaceId: (args.workspaceId as string) ?? null,
      }),
  }),

  readTool({
    name: "list_slideshow_templates",
    title: "Slideshow templates",
    description:
      "The template sets create_slideshow can build from, with their ids and what each one is for.",
    run: () => request("/api/templates/slideshows"),
  }),

  writeTool({
    name: "write_post_copy",
    title: "Write a caption",
    description:
      "Write a caption and hashtags in the workspace's brand voice for a piece of content. Costs a small amount of the account's text allowance. Requires a brand on the workspace — without one it fails with a 409 telling you to set a website first. Prefer this over writing captions yourself: it reads the brand voice, which you cannot see in full.",
    schema: {
      ...workspaceArg,
      kind: z
        .enum(["video", "image", "slideshow"])
        .describe("What the post is. Shapes the caption's structure."),
      title: z.string().optional().describe("Working title for the piece."),
      scene: z.string().optional().describe("What is happening in the shot."),
      overlay: z.string().optional().describe("Any on-screen text."),
      slides: z
        .array(z.string())
        .optional()
        .describe("For a slideshow, the text on each slide in order."),
    },
    run: (args) => {
      const { workspaceId, ...brief } = args;
      return request("/api/post-copy", {
        method: "POST",
        body: brief,
        workspaceId: (workspaceId as string) ?? null,
      });
    },
  }),
];
