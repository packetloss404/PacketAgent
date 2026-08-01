import { AppIterationRouteRequest } from "./contracts.js";
import {
  applyAppBuilderDraft,
  buildAppBuilderDraft,
  promptFromBody,
  streamTemplateNarration,
} from "./draft.js";
import {
  applyAppIteration,
  buildBuilderFixPrompt,
  generateAppIteration,
  refreshBuilderPreview,
  runAppIterationCore,
} from "./iteration.js";
import {
  approveAgentBuilderDraftAsync,
  generateAgentBuilderDraftAsync,
  requireAuthenticatedContextAsync,
} from "../../packetagent-services.js";
import { branchAppCheckpoint, listAppCheckpoints, rollbackAppCheckpoint } from "./checkpoints.js";
import {
  buildGeneratedAppRuntimeArtifactFromFiles,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import {
  chatStreamDelay,
  emitProse,
  emitStep,
  errorResponse,
  llmIsAvailable,
  presetStepLabel,
  requireWorkspacePermission,
} from "../shared.js";
import {
  exportGeneratedAppDockerCompose,
  getGeneratedAppPublishIntegrity,
  getGeneratedAppPublishState,
  listAppPublishHistory,
  prepareGeneratedAppPublish,
  publishGeneratedApp,
  rollbackGeneratedAppPublish,
} from "./publish.js";
import {
  exportGeneratedAppWorkspace,
  getGeneratedAppPackagePlan,
  getGeneratedAppSourceFiles,
  listGeneratedApps,
} from "./generated-apps.js";
import { generateAppDraftFromPrompt, generateAppDraftWithLLM } from "../../app-builder-service.js";
import { redactedErrorMessage } from "../../security/redaction.js";
import { streamSSE } from "hono/streaming";
import { type Hono } from "hono";
import { type ModelRoutingPresetId } from "../../model-routing-presets.js";

export function registerBuilderRoutes(app: Hono): void {
  app.post("/app/builder/agent-draft", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
      return c.json({
        draft: await generateAgentBuilderDraftAsync(context, {
          prompt: body.prompt,
          preset: body.preset,
          signal: c.req.raw.signal,
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/agent-draft/approve", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as {
        prompt?: string;
        draft?: Parameters<typeof approveAgentBuilderDraftAsync>[1]["draft"];
        runPreview?: boolean;
        sampleInputs?: Record<string, unknown>;
        status?: "active" | "paused" | "archived";
      };
      return c.json(
        await approveAgentBuilderDraftAsync(context, {
          prompt: body.prompt,
          draft: body.draft,
          runPreview: Boolean(body.runPreview),
          sampleInputs: body.sampleInputs,
          status: body.status,
        }),
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/app-draft", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
      const draft = generateAppDraftFromPrompt(promptFromBody(body.prompt));
      return c.json({ draft: buildAppBuilderDraft(draft, context) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/app-draft/stream", async (c) => {
    let context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;
    let body: { prompt?: string; preset?: ModelRoutingPresetId };
    try {
      context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
    } catch (error) {
      return errorResponse(c, error);
    }
    return streamSSE(c, async (sse) => {
      try {
        const presetLabel = presetStepLabel(body.preset);
        if (presetLabel) {
          await emitStep(sse, presetLabel);
          await chatStreamDelay();
        }
        await emitStep(sse, "Reading the prompt");
        await chatStreamDelay();
        const prompt = promptFromBody(body.prompt);
        // The file-tree path resolves the selected preset through the provider
        // router, then falls back to the structured draft or deterministic
        // template path when no compatible provider is ready.
        // The emit callback forwards model prose token-by-token to the UI as SSE
        // "prose" events so the chat bubble streams as the model thinks.
        const { draft, source, files, validationErrors } = await generateAppDraftWithLLM(
          prompt,
          {
            preset: body.preset,
            workspaceId: context.workspace.id,
            onFileProgress: async (progress) => {
              await sse.writeSSE({
                event: "file-progress",
                data: JSON.stringify({ type: "file-progress", progress }),
              });
            },
          },
          async (text) => {
            await sse.writeSSE({ event: "prose", data: JSON.stringify({ type: "prose", text }) });
          },
        );
        await emitStep(
          sse,
          source === "llm-filetree"
            ? `Authored ${files?.length ?? 0} generated files`
            : source === "llm"
              ? `Drafted with AI (${draft.templateId} shape)`
              : `Selected the ${draft.templateId} template`,
        );
        await chatStreamDelay();
        await emitStep(sse, "Building data schema and API routes");
        await chatStreamDelay();
        const built = buildAppBuilderDraft(draft, context);
        // When no LLM ran (template fallback), synthesize conversational
        // narration so the chat thread isn't silent. The LLM paths already
        // emit their own prose via the `emit` callback above.
        if (source === "template") {
          await streamTemplateNarration(sse, draft);
        }
        const sourceArtifact = files?.length
          ? buildGeneratedAppRuntimeArtifactFromFiles(files)
          : undefined;
        await sse.writeSSE({
          event: "draft",
          data: JSON.stringify({
            type: "draft",
            draft: built,
            source,
            files,
            sourceFiles: sourceArtifact
              ? summarizeGeneratedAppSourceFiles(sourceArtifact.files)
              : undefined,
            validationErrors,
          }),
        });
        await sse.writeSSE({ event: "done", data: JSON.stringify({ type: "done" }) });
      } catch (error) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: redactedErrorMessage(error) }),
        });
      }
    });
  });

  app.get("/app/generated-apps", async (c) => listGeneratedApps(c));
  app.get("/app/generated-apps/:appId/source", async (c) => getGeneratedAppSourceFiles(c));
  app.get("/app/generated-apps/:appId/source-files", async (c) => getGeneratedAppSourceFiles(c));
  app.get("/app/generated-apps/:appId/package-plan", async (c) => getGeneratedAppPackagePlan(c));
  app.get("/app/generated-apps/:appId/export", async (c) => exportGeneratedAppWorkspace(c));
  app.post("/app/builder/app-draft/apply", async (c) => applyAppBuilderDraft(c));
  app.post("/app/builder/app-draft/approve", async (c) => applyAppBuilderDraft(c));
  app.post("/app/builder/app-iteration", async (c) => generateAppIteration(c));
  app.post("/app/builder/app-iteration/apply", async (c) => applyAppIteration(c));

  app.post("/app/builder/app-iteration/stream", async (c) => {
    let context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;
    let body: AppIterationRouteRequest;
    try {
      context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      body = (await c.req.json()) as AppIterationRouteRequest;
    } catch (error) {
      return errorResponse(c, error);
    }
    return streamSSE(c, async (sse) => {
      try {
        const presetLabel = presetStepLabel(body.preset);
        if (presetLabel) {
          await emitStep(sse, presetLabel);
          await chatStreamDelay();
        }
        const useLLM = llmIsAvailable();
        const result = await runAppIterationCore(
          context,
          body,
          async (text) => {
            if (useLLM) return; // suppress synthetic steps when prose stream is active
            await emitStep(sse, text);
            await chatStreamDelay();
          },
          useLLM
            ? async (chunk) => {
                await emitProse(sse, chunk);
              }
            : undefined,
          async (progress) => {
            await sse.writeSSE({
              event: "file-progress",
              data: JSON.stringify({ type: "file-progress", progress }),
            });
          },
        );
        await sse.writeSSE({
          event: "diff",
          data: JSON.stringify({ type: "diff", iteration: result }),
        });
        if (result.validationErrors?.length) {
          await sse.writeSSE({
            event: "validation",
            data: JSON.stringify({ type: "validation", errors: result.validationErrors }),
          });
        }
        await sse.writeSSE({ event: "done", data: JSON.stringify({ type: "done" }) });
      } catch (error) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: redactedErrorMessage(error) }),
        });
      }
    });
  });

  app.post("/app/builder/changes/draft", async (c) => generateAppIteration(c, "changeSet"));
  app.post("/app/builder/changes/apply", async (c) => applyAppIteration(c, "changeSet"));
  app.post("/app/builder/preview/refresh", async (c) => refreshBuilderPreview(c));
  app.post("/app/builder/fix-prompt", async (c) => buildBuilderFixPrompt(c));
  app.get("/app/builder/checkpoints", async (c) => listAppCheckpoints(c));
  app.post("/app/builder/checkpoints/:checkpointId/rollback", async (c) =>
    rollbackAppCheckpoint(c),
  );
  app.post("/app/builder/checkpoints/:checkpointId/branch", async (c) => branchAppCheckpoint(c));
  app.post("/app/builder/publish/prepare", async (c) => prepareGeneratedAppPublish(c));
  app.post("/app/builder/publish/readiness", async (c) => prepareGeneratedAppPublish(c));
  app.post("/app/builder/publishes/readiness", async (c) => prepareGeneratedAppPublish(c));
  app.get("/app/builder/publish/state", async (c) => getGeneratedAppPublishState(c));
  app.get("/app/builder/publish/history", async (c) => listAppPublishHistory(c));
  app.get("/app/builder/publishes", async (c) => listAppPublishHistory(c));
  app.get("/app/builder/publishes/history", async (c) => listAppPublishHistory(c));
  app.get("/app/generated-apps/:appId/publish/integrity", async (c) =>
    getGeneratedAppPublishIntegrity(c),
  );
  app.get("/app/builder/publish/docker-compose", async (c) => exportGeneratedAppDockerCompose(c));
  app.get("/app/builder/publishes/docker-compose", async (c) => exportGeneratedAppDockerCompose(c));
  app.post("/app/builder/publish", async (c) => publishGeneratedApp(c));
  app.post("/app/builder/publishes", async (c) => publishGeneratedApp(c));
  app.post("/app/builder/publish/:publishId/rollback", async (c) => rollbackGeneratedAppPublish(c));
  app.post("/app/builder/publishes/:publishId/rollback", async (c) =>
    rollbackGeneratedAppPublish(c),
  );
}
