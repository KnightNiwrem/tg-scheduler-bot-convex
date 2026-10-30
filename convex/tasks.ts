// Helpers shared by one-time and recurring schedules. A task id identifies at
// most one schedule of either kind per client.

import { Crons } from "@convex-dev/crons";
import { v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";

export const crons = new Crons(components.crons);

export type Task =
  | { kind: "once"; doc: Doc<"schedules"> }
  | { kind: "cron"; doc: Doc<"recurring"> };

export async function findTask(
  ctx: QueryCtx,
  clientId: number,
  taskId: string,
): Promise<Task | null> {
  const once = await ctx.db
    .query("schedules")
    .withIndex("by_client_task", (q) => q.eq("clientId", clientId).eq("taskId", taskId))
    .unique();
  if (once) return { kind: "once", doc: once };
  const cron = await ctx.db
    .query("recurring")
    .withIndex("by_client_task", (q) => q.eq("clientId", clientId).eq("taskId", taskId))
    .unique();
  return cron ? { kind: "cron", doc: cron } : null;
}

/** Describes an existing task for conflict errors, e.g. `for 2026-11-01T09:30:00.000Z (pending)`. */
export function describeTask(task: Task): string {
  return task.kind === "once"
    ? `for ${new Date(task.doc.runAt).toISOString()} (${task.doc.status})`
    : `as cron "${task.doc.cronspec}" (${task.doc.status})`;
}

type CancelResult =
  | { kind: "cancelled" }
  | { kind: "not_found" }
  | { kind: "not_cancellable"; status: string };

/**
 * Cancels a pending one-time schedule or stops a recurring one. Idempotent:
 * cancelling a cancelled task succeeds again.
 */
export const cancel = internalMutation({
  args: { clientId: v.number(), taskId: v.string() },
  handler: async (ctx, { clientId, taskId }): Promise<CancelResult> => {
    const task = await findTask(ctx, clientId, taskId);
    if (!task) return { kind: "not_found" };
    if (task.doc.status === "cancelled") return { kind: "cancelled" };

    if (task.kind === "once") {
      // A schedule that is being sent or has finished can no longer be stopped.
      if (task.doc.status !== "pending")
        return { kind: "not_cancellable", status: task.doc.status };
      // The queued deliver run still fires, but its claim fails, so nothing is sent.
      await ctx.db.patch("schedules", task.doc._id, { status: "cancelled" });
    } else {
      if (task.doc.status !== "active") return { kind: "not_cancellable", status: task.doc.status };
      if (task.doc.cronId) await crons.delete(ctx, { id: task.doc.cronId });
      await ctx.db.patch("recurring", task.doc._id, { status: "cancelled" });
    }
    return { kind: "cancelled" };
  },
});
