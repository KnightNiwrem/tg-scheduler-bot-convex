import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { formatDue, previousRun } from "./protocol";
import { conflict, crons, findTask, type Rejection } from "./tasks";
import { createApi, isPermanentError } from "./telegram";

/** Recurring schedules fire forever, so each client may only have this many active at once. */
export const MAX_ACTIVE_PER_CLIENT = 50;

/**
 * Stores a recurring schedule and registers its cron. Idempotent per (client,
 * task), like one-time schedules. The cron is registered in the same
 * transaction, so a stored schedule always has a cron and vice versa.
 */
export async function createRecurring(
  ctx: MutationCtx,
  clientId: number,
  taskId: string,
  cronspec: string,
): Promise<Rejection> {
  const existing = await findTask(ctx, clientId, taskId);
  if (existing) {
    const same =
      existing.kind === "cron" &&
      existing.doc.cronspec === cronspec &&
      existing.doc.status === "active";
    return same ? null : conflict(existing);
  }

  const active = await ctx.db
    .query("recurring")
    .withIndex("by_client_status", (q) => q.eq("clientId", clientId).eq("status", "active"))
    .take(MAX_ACTIVE_PER_CLIENT);
  if (active.length >= MAX_ACTIVE_PER_CLIENT) {
    return {
      code: "quota_exceeded",
      detail: `at most ${MAX_ACTIVE_PER_CLIENT} recurring schedules can be active, cancel one first`,
    };
  }

  const recurringId = await ctx.db.insert("recurring", {
    clientId,
    taskId,
    cronspec,
    status: "active",
  });
  const cronId = await crons.register(
    ctx,
    { kind: "cron", cronspec, tz: "UTC" },
    internal.recurring.fire,
    { recurringId },
  );
  await ctx.db.patch("recurring", recurringId, { cronId });
  return null;
}

/**
 * Claims the run of an active schedule that is due now. The crons component
 * does not say which run it is calling for, so it is taken to be the latest
 * one at or before now. Returns null if that run was already claimed, so each
 * run is sent at most once, and always with the same delivery id.
 */
export const claimRun = internalMutation({
  args: { recurringId: v.id("recurring") },
  handler: async (ctx, { recurringId }) => {
    const schedule = await ctx.db.get("recurring", recurringId);
    if (schedule?.status !== "active") return null;
    const scheduledFor = previousRun(schedule.cronspec, Date.now());
    if (schedule.lastRunFor !== undefined && scheduledFor <= schedule.lastRunFor) return null;
    await ctx.db.patch("recurring", recurringId, { lastRunFor: scheduledFor });
    return { clientId: schedule.clientId, taskId: schedule.taskId, scheduledFor };
  },
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
    if (schedule?.status !== "active") return;
    if (permanent && schedule.cronId) await crons.delete(ctx, { id: schedule.cronId });
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
    const schedule = await ctx.runMutation(internal.recurring.claimRun, { recurringId });
    if (!schedule) return;

    try {
      await createApi().sendMessage(
        schedule.clientId,
        formatDue(schedule.taskId, schedule.scheduledFor),
      );
    } catch (error) {
      console.error(
        `Recurring delivery of ${schedule.taskId} to ${schedule.clientId} failed:`,
        error,
      );
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
