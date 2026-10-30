import { Api, GrammyError } from "grammy";
import { internalAction } from "./_generated/server";

export const WEBHOOK_PATH = "/telegram/webhook";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** grammY client options. BOT_API_ROOT is optional (local Bot API server or the local e2e test). */
export function clientConfig() {
  const apiRoot = process.env.BOT_API_ROOT;
  return apiRoot ? { apiRoot } : undefined;
}

export const createApi = () => new Api(env("BOT_TOKEN"), clientConfig());

/** True for Bot API errors that retrying will not fix, e.g. 403 blocked or 400 chat not found. */
export function isPermanentError(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code < 500 && error.error_code !== 429;
}

/** Points the scheduler bot's webhook at this deployment. Run: bunx convex run telegram:setWebhook */
export const setWebhook = internalAction({
  args: {},
  handler: async () => {
    const api = createApi();
    await api.setWebhook(`${env("CONVEX_SITE_URL")}${WEBHOOK_PATH}`, {
      secret_token: env("BOT_WEBHOOK_SECRET"),
      allowed_updates: ["message"],
    });
    return await api.getWebhookInfo();
  },
});

/** Shows the bot identity and webhook health. Run: bunx convex run telegram:status */
export const status = internalAction({
  args: {},
  handler: async () => {
    const api = createApi();
    const [me, webhook] = await Promise.all([api.getMe(), api.getWebhookInfo()]);
    return { me, webhook };
  },
});
