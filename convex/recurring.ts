import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { formatDue } from "./protocol";
import type { CreateResult } from "./schedules";
import { crons, describeTask, findTask } from "./tasks";
import { createApi, isPermanentError } from "./telegram";

/** Recurring schedules fire forever, so each client may only have this many active at once. */
export const MAX_ACTIVE_PER_CLIENT = 50;

/**
 * Stores a recurring schedule and registers its cron. Idempotent per (client,
 * task), like one-time schedules. The cron is registered in the same
 * transaction, so a stored schedule always has a cron and vice versa.
 */
export const create = internalMutation({
  args: { clientId: v.number(), taskId: v.string(), cronspec: v.string() },
  handler: async (ctx, args): Promise<CreateResult> => {
    const existing = await findTask(ctx, args.clientId, args.taskId);
    if (existing) {
      const same =
        existing.kind === "cron" &&
        existing.doc.cronspec === args.cronspec &&
        existing.doc.status === "active";
      return same ? { kind: "duplicate" } : { kind: "conflict", existing: describeTask(existing) };
    }

    const active = await ctx.db
      .query("recurring")
      .withIndex("by_client_status", (q) => q.eq("clientId", args.clientId).eq("status", "active"))
      .take(MAX_ACTIVE_PER_CLIENT);
    if (active.length >= MAX_ACTIVE_PER_CLIENT) return { kind: "quota_exceeded" };

    const recurringId = await ctx.db.insert("recurring", { ...args, status: "active" });
    const cronId = await crons.register(
      ctx,
      { kind: "cron", cronspec: args.cronspec, tz: "UTC" },
      internal.recurring.fire,
      { recurringId },
    );
    await ctx.db.patch("recurring", recurringId, { cronId });
    return { kind: "created" };
  },
});

export const get = internalQuery({
  args: { recurringId: v.id("recurring") },
  handler: (ctx, { recurringId }) => ctx.db.get("recurring", recurringId),
});

export const markDelivered = internalMutation({
  args: { recurringId: v.id("recurring") },
  handler: async (ctx, { recurringId }) => {
    await ctx.db.patch("recurring", recurringId, {
      lastDeliveredAt: Date.now(),
      lastError: undefined,
    });
  },
});

/**
 * Records a failed run. A permanent error (e.g. the client blocked the
 * scheduler) stops the schedule. Transient errors are not retried: the next
 * run is at most a few minutes away, and a retry could overlap with it.
 */
export const markFailed = internalMutation({
  args: { recurringId: v.id("recurring"), error: v.string(), permanent: v.boolean() },
  handler: async (ctx, { recurringId, error, permanent }) => {
    const schedule = await ctx.db.get("recurring", recurringId);
    if (!schedule || schedule.status !== "active") return;
    if (permanent) await crons.delete(ctx, { id: schedule.cronId! });
    await ctx.db.patch("recurring", recurringId, {
      status: permanent ? "failed" : "active",
      lastError: error.slice(0, 500),
    });
  },
});

/** Called by the cron on every run. Sends the notification to the client bot. */
export const fire = internalAction({
  args: { recurringId: v.id("recurring") },
  handler: async (ctx, { recurringId }): Promise<void> => {
    const schedule = await ctx.runQuery(internal.recurring.get, { recurringId });
    if (schedule?.status !== "active") return;

    try {
      await createApi().sendMessage(schedule.clientId, formatDue(schedule.taskId));
    } catch (error) {
      console.error(`Recurring delivery of ${schedule.taskId} to ${schedule.clientId} failed:`, error);
      await ctx.runMutation(internal.recurring.markFailed, {
        recurringId,
        error: String(error),
        permanent: isPermanentError(error),
      });
      return;
    }
    await ctx.runMutation(internal.recurring.markDelivered, { recurringId });
  },
});
