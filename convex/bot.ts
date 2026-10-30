import { Bot } from "grammy";
import type { User, UserFromGetMe } from "grammy/types";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  type Command,
  formatAck,
  formatCancelled,
  formatCronAck,
  formatError,
  parseCancelRequest,
  parseCommand,
  parseCronRequest,
  parseScheduleRequest,
} from "./protocol";
import { MAX_ACTIVE_PER_CLIENT } from "./recurring";
import type { CreateResult } from "./schedules";
import { clientConfig, env } from "./telegram";

// Kept for as long as Convex reuses the isolate, which saves a getMe call per update.
let botInfo: UserFromGetMe | undefined;

/** Builds a grammY bot bound to the Convex context of the current webhook request. */
export async function createBot(ctx: ActionCtx) {
  const bot = new Bot(env("BOT_TOKEN"), { botInfo, client: clientConfig() });
  await bot.init();
  botInfo = bot.botInfo;

  const isAllowed = parseAllowlist(env("ALLOWED_BOT_IDS"));

  // Log and acknowledge failed updates instead of returning an error to
  // Telegram, which would redeliver the same update over and over. This has to
  // be an error boundary: bot.catch() only applies to long polling, and with
  // webhooks the error would escape webhookCallback as a 500.
  const safe = bot.errorBoundary((err) => {
    console.error(`Failed to handle update ${err.ctx.update.update_id}:`, err.error);
  });

  safe.chatType("private").on("message:text", async (c) => {
    // Unauthorized senders and anything that is not a command are ignored
    // without a reply, so the bot cannot be drawn into a reply loop.
    if (!isAllowed(c.from)) {
      console.warn(`Ignoring message from unauthorized sender ${c.from.id}`);
      return;
    }
    const command = parseCommand(c.msg.text, c.me.username);
    if (!command) return;

    const reply = await handlers[command](ctx, c.from.id, c.msg.text);
    await c.reply(reply, {
      reply_parameters: { message_id: c.msg.message_id, allow_sending_without_reply: true },
    });
  });

  return bot;
}

type Handler = (ctx: ActionCtx, clientId: number, text: string) => Promise<string>;

const handlers: Record<Command, Handler> = {
  async schedule(ctx, clientId, text) {
    const parsed = parseScheduleRequest(text, Date.now());
    if (!parsed.ok) return formatError(parsed.code, parsed.detail);
    return await store(
      parsed.taskId,
      () =>
        ctx.runMutation(internal.schedules.create, {
          clientId,
          taskId: parsed.taskId,
          runAt: parsed.runAt,
        }),
      () => formatAck(parsed.taskId, parsed.runAt),
    );
  },

  async cron(ctx, clientId, text) {
    const parsed = parseCronRequest(text);
    if (!parsed.ok) return formatError(parsed.code, parsed.detail);
    return await store(
      parsed.taskId,
      () =>
        ctx.runMutation(internal.recurring.create, {
          clientId,
          taskId: parsed.taskId,
          cronspec: parsed.cronspec,
        }),
      () => formatCronAck(parsed.taskId, parsed.cronspec),
    );
  },

  async cancel(ctx, clientId, text) {
    const parsed = parseCancelRequest(text);
    if (!parsed.ok) return formatError(parsed.code, parsed.detail);
    try {
      const result = await ctx.runMutation(internal.tasks.cancel, {
        clientId,
        taskId: parsed.taskId,
      });
      switch (result.kind) {
        case "cancelled":
          return formatCancelled(parsed.taskId);
        case "not_found":
          return formatError("not_found", `no schedule for task ${parsed.taskId}`);
        case "not_cancellable":
          return formatError(
            "not_found",
            `task ${parsed.taskId} is no longer pending (${result.status})`,
          );
      }
    } catch (error) {
      console.error("Failed to cancel schedule:", error);
      return formatError("internal", "could not cancel the schedule, try again later");
    }
  },
};

/** Runs a create mutation and turns its result into a reply. */
async function store(taskId: string, create: () => Promise<CreateResult>, ack: () => string) {
  try {
    const result = await create();
    switch (result.kind) {
      case "created":
      case "duplicate":
        return ack();
      case "conflict":
        return formatError("conflict", `task ${taskId} is already scheduled ${result.existing}`);
      case "quota_exceeded":
        return formatError(
          "quota_exceeded",
          `at most ${MAX_ACTIVE_PER_CLIENT} recurring schedules can be active, cancel one first`,
        );
    }
  } catch (error) {
    console.error("Failed to store schedule:", error);
    return formatError("internal", "could not store the schedule, try again later");
  }
}

/**
 * `*` allows any bot (but not human users). Otherwise a comma-separated list of
 * Telegram user ids, which may include humans for manual testing.
 */
function parseAllowlist(value: string): (sender: User) => boolean {
  if (value.trim() === "*") return (sender) => sender.is_bot;
  const ids = value.split(",").map((id) => Number(id.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error("ALLOWED_BOT_IDS must be `*` or a comma-separated list of Telegram user ids");
  }
  const allowed = new Set(ids);
  return (sender) => allowed.has(sender.id);
}
