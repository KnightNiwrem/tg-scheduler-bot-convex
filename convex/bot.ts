import { Bot } from "grammy";
import type { User, UserFromGetMe } from "grammy/types";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  formatAck,
  formatError,
  isScheduleCommand,
  parseScheduleRequest,
} from "./protocol";
import { clientConfig, env } from "./telegram";

// Kept for as long as Convex reuses the isolate, which saves a getMe call per update.
let botInfo: UserFromGetMe | undefined;

/** Builds a grammY bot bound to the Convex context of the current webhook request. */
export async function createBot(ctx: ActionCtx) {
  const bot = new Bot(env("BOT_TOKEN"), { botInfo, client: clientConfig() });
  await bot.init();
  botInfo = bot.botInfo;

  const isAllowed = parseAllowlist(env("ALLOWED_BOT_IDS"));

  bot.chatType("private").on("message:text", async (c) => {
    // Unauthorized senders and anything that is not a /schedule request are
    // ignored without a reply, so the bot cannot be drawn into a reply loop.
    if (!isAllowed(c.from)) {
      console.warn(`Ignoring message from unauthorized sender ${c.from.id}`);
      return;
    }
    if (!isScheduleCommand(c.msg.text, c.me.username)) return;

    const reply = await handleScheduleRequest(ctx, c.from.id, c.msg.text);
    await c.reply(reply, {
      reply_parameters: { message_id: c.msg.message_id, allow_sending_without_reply: true },
    });
  });

  // Log and acknowledge failed updates instead of returning an error to
  // Telegram, which would redeliver the same update over and over.
  bot.catch((err) => {
    console.error(`Failed to handle update ${err.ctx.update.update_id}:`, err.error);
  });

  return bot;
}

async function handleScheduleRequest(ctx: ActionCtx, clientId: number, text: string) {
  const parsed = parseScheduleRequest(text, Date.now());
  if (!parsed.ok) return formatError(parsed.code, parsed.detail);

  try {
    const result = await ctx.runMutation(internal.schedules.create, {
      clientId,
      taskId: parsed.taskId,
      runAt: parsed.runAt,
    });
    if (result.kind === "conflict") {
      const existingAt = new Date(result.runAt).toISOString();
      return formatError(
        "conflict",
        `task ${parsed.taskId} is already scheduled for ${existingAt} (${result.status})`,
      );
    }
    return formatAck(parsed.taskId, parsed.runAt);
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
