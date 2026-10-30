import { Bot } from "grammy";
import type { User, UserFromGetMe } from "grammy/types";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { formatError, parseRequest, type Request } from "./protocol";
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
    // Unauthorized senders and anything that is not a request are ignored
    // without a reply, so the bot cannot be drawn into a reply loop.
    if (!isAllowed(c.from)) {
      console.warn(`Ignoring message from unauthorized sender ${c.from.id}`);
      return;
    }
    const parsed = parseRequest(c.msg.text);
    if (parsed.kind === "ignored") return;

    const reply =
      parsed.kind === "invalid"
        ? formatError(parsed.requestId, parsed.code, parsed.detail)
        : await handle(ctx, c.from.id, parsed.request);
    await c.reply(reply, {
      reply_parameters: { message_id: c.msg.message_id, allow_sending_without_reply: true },
    });
  });

  return bot;
}

async function handle(ctx: ActionCtx, clientId: number, request: Request): Promise<string> {
  try {
    return await ctx.runMutation(internal.requests.handle, { clientId, request });
  } catch (error) {
    console.error(`Failed to handle ${request.type} request ${request.requestId}:`, error);
    return formatError(request.requestId, "internal", "could not handle the request, try again");
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
