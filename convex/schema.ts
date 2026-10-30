import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One-time schedules (/schedule).
  schedules: defineTable({
    // Telegram user id of the requesting bot. In a private chat this is also
    // the chat id the notification is sent to.
    clientId: v.number(),
    taskId: v.string(),
    runAt: v.number(),
    // pending -> sending -> delivered
    //    |          \-> pending (retryable error) | failed
    //    \-> cancelled
    status: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
  }).index("by_client_task", ["clientId", "taskId"]),

  // Recurring schedules (/cron). Each active one has a cron registered in the
  // crons component.
  recurring: defineTable({
    clientId: v.number(),
    taskId: v.string(),
    // Five-field cron expression, evaluated in UTC.
    cronspec: v.string(),
    // Id of the cron in the crons component. Set right after the insert.
    cronId: v.optional(v.string()),
    // active -> cancelled (by the client) | failed (permanent delivery error)
    status: v.union(v.literal("active"), v.literal("cancelled"), v.literal("failed")),
    lastDeliveredAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_client_task", ["clientId", "taskId"])
    .index("by_client_status", ["clientId", "status"]),
});
