import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  schedules: defineTable({
    // Telegram user id of the requesting bot. In a private chat this is also
    // the chat id the notification is sent to.
    clientId: v.number(),
    taskId: v.string(),
    runAt: v.number(),
    // pending -> sending -> delivered
    //               \-> pending (retryable error) | failed
    status: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    deliveredAt: v.optional(v.number()),
  }).index("by_client_task", ["clientId", "taskId"]),
});
