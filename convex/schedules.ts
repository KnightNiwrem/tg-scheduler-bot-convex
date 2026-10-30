import { v } from "convex/values";
import { GrammyError } from "grammy";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { checkRunAt, formatDue } from "./protocol";
import { conflict, findTask, type Rejection } from "./tasks";
import { createApi, isPermanentError } from "./telegram";

const MAX_ATTEMPTS = 3;

/**
 * Stores a schedule and enqueues its delivery. Idempotent per (client, task):
 * repeating a request is a no-op, reusing a task id for another time (or for a
 * recurring schedule) is a conflict. Convex mutations are serializable, so
 * concurrent duplicates cannot both insert.
 */
export async function createOnce(
  ctx: MutationCtx,
  clientId: number,
  taskId: string,
  runAt: number,
): Promise<Rejection> {
  const existing = await findTask(ctx, clientId, taskId);
  if (existing) {
    const same =
      existing.kind === "once" &&
      existing.doc.runAt === runAt &&
      existing.doc.status !== "cancelled";
    return same ? null : conflict(existing);
  }
  // After the duplicate check, so a repeated request is acked even once its time has passed.
  const outOfRange = checkRunAt(runAt, Date.now());
  if (outOfRange) return outOfRange;

  const scheduleId = await ctx.db.insert("schedules", {
    clientId,
    taskId,
    runAt,
    status: "pending",
    attempts: 0,
  });
  // Atomic with the insert: either both happen or neither does.
  await ctx.scheduler.runAt(runAt, internal.schedules.deliver, { scheduleId });
  return null;
}

/** Moves a pending schedule to "sending". Returns null if it is not pending, so it is never sent twice. */
export const claim = internalMutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    const schedule = await ctx.db.get("schedules", scheduleId);
    if (schedule?.status !== "pending") return null;
    const attempts = schedule.attempts + 1;
    await ctx.db.patch("schedules", scheduleId, { status: "sending", attempts });
    return {
      clientId: schedule.clientId,
      taskId: schedule.taskId,
      runAt: schedule.runAt,
      attempts,
    };
  },
});

export const markDelivered = internalMutation({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }) => {
    await ctx.db.patch("schedules", scheduleId, {
      status: "delivered",
      deliveredAt: Date.now(),
      lastError: undefined,
    });
  },
});

/** Records a failed attempt and retries it later if the error is transient and attempts remain. */
export const markFailed = internalMutation({
  args: {
    scheduleId: v.id("schedules"),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, { scheduleId, error, retryAfterMs }) => {
    const schedule = await ctx.db.get("schedules", scheduleId);
    if (!schedule) return;
    const retry = retryAfterMs !== undefined && schedule.attempts < MAX_ATTEMPTS;
    await ctx.db.patch("schedules", scheduleId, {
      status: retry ? "pending" : "failed",
      lastError: error.slice(0, 500),
    });
    if (retry) {
      await ctx.scheduler.runAfter(retryAfterMs, internal.schedules.deliver, { scheduleId });
    }
  },
});

/** Runs at the scheduled time and sends the notification to the client bot. */
export const deliver = internalAction({
  args: { scheduleId: v.id("schedules") },
  handler: async (ctx, { scheduleId }): Promise<void> => {
    const schedule = await ctx.runMutation(internal.schedules.claim, { scheduleId });
    if (!schedule) return;

    try {
      await createApi().sendMessage(schedule.clientId, formatDue(schedule.taskId, schedule.runAt));
    } catch (error) {
      console.error(`Delivery of ${schedule.taskId} to ${schedule.clientId} failed:`, error);
      await ctx.runMutation(internal.schedules.markFailed, {
        scheduleId,
        error: String(error),
        retryAfterMs: retryDelayMs(error, schedule.attempts),
      });
      return;
    }
    // Outside the try block: a failure here must not trigger a second send.
    await ctx.runMutation(internal.schedules.markDelivered, { scheduleId });
  },
});

/** Delay before retrying, or undefined if the error is permanent (e.g. 403 blocked, 400 chat not found). */
function retryDelayMs(error: unknown, attempts: number): number | undefined {
  if (isPermanentError(error)) return undefined;
  if (error instanceof GrammyError && error.error_code === 429) {
    return (error.parameters.retry_after ?? 30) * 1000;
  }
  // Network errors and Telegram 5xx.
  return 30_000 * attempts;
}
