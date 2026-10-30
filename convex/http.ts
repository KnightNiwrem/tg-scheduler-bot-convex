import { httpRouter } from "convex/server";
import { webhookCallback } from "grammy";
import { httpAction } from "./_generated/server";
import { createBot } from "./bot";
import { env, WEBHOOK_PATH } from "./telegram";

const http = httpRouter();

http.route({
  path: WEBHOOK_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secretToken = env("TELEGRAM_WEBHOOK_SECRET");
    // grammY checks the secret too, but only after calling getMe. Reject
    // forged requests before they cost a Telegram API call.
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secretToken) {
      return new Response("unauthorized", { status: 401 });
    }
    const bot = await createBot(ctx);
    return await webhookCallback(bot, "std/http", { secretToken })(request);
  }),
});

export default http;
