// Request-level idempotency. Each request carries a client-generated request
// id. The ack of a request is stored with that id, so a retry gets the exact
// same ack back, even after the task has moved on (been delivered, cancelled,
// or its time has passed). Errors are not stored: a request that got an error
// changed nothing, and retrying it with the same id evaluates it again.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { fingerprint, formatAck, formatError, type Request } from "./protocol";
import { createRecurring } from "./recurring";
import { createOnce } from "./schedules";
import { cancelTask, type Rejection } from "./tasks";

/** How long request ids are remembered. After that, a retry falls back to task-level idempotency. */
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

const requestValidator = v.union(
  v.object({
    type: v.literal("schedule"),
    requestId: v.string(),
    taskId: v.string(),
    runAt: v.number(),
  }),
  v.object({
    type: v.literal("cron"),
    requestId: v.string(),
    taskId: v.string(),
    cronspec: v.string(),
  }),
  v.object({ type: v.literal("cancel"), requestId: v.string(), taskId: v.string() }),
);

/**
 * Applies a request and returns the reply. The request id lookup, the change
 * to the task and the stored ack are one transaction, so a request is applied
 * at most once and its ack always matches what was stored.
 */
export const handle = internalMutation({
  args: { clientId: v.number(), request: requestValidator },
  handler: async (ctx, { clientId, request }): Promise<string> => {
    const { requestId } = request;
    const print = fingerprint(request);
    const seen = await ctx.db
      .query("requests")
      .withIndex("by_client_request", (q) => q.eq("clientId", clientId).eq("requestId", requestId))
      .unique();
    if (seen) {
      return seen.fingerprint === print
        ? seen.response
        : formatError(
            requestId,
            "request_id_reused",
            `request id ${requestId} was already used for a different request`,
          );
    }

    const rejection = await apply(ctx, clientId, request);
    if (rejection) return formatError(requestId, rejection.code, rejection.detail);

    const response = formatAck(request);
    await ctx.db.insert("requests", { clientId, requestId, fingerprint: print, response });
    return response;
  },
});

function apply(ctx: MutationCtx, clientId: number, request: Request): Promise<Rejection> {
  switch (request.type) {
    case "schedule":
      return createOnce(ctx, clientId, request.taskId, request.runAt);
    case "cron":
      return createRecurring(ctx, clientId, request.taskId, request.cronspec);
    case "cancel":
      return cancelTask(ctx, clientId, request.taskId);
  }
}

/** Forgets request ids older than REQUEST_RETENTION_MS. Runs daily (see crons.ts). */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - REQUEST_RETENTION_MS;
    const expired = await ctx.db
      .query("requests")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(PRUNE_BATCH);
    for (const doc of expired) await ctx.db.delete("requests", doc._id);
    if (expired.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.requests.prune, {});
    }
  },
});
