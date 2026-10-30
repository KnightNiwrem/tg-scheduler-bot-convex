import { Api } from "grammy";
import { internalAction } from "./_generated/server";

export const WEBHOOK_PATH = "/telegram/webhook";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/** grammY client options. TELEGRAM_API_ROOT is optional (local Bot API server or the local e2e test). */
export function clientConfig() {
  const apiRoot = process.env.TELEGRAM_API_ROOT;
  return apiRoot ? { apiRoot } : undefined;
}

export const createApi = () => new Api(env("TELEGRAM_BOT_TOKEN"), clientConfig());

/** Points the scheduler bot's webhook at this deployment. Run: bunx convex run telegram:setWebhook */
export const setWebhook = internalAction({
  args: {},
  handler: async () => {
    const api = createApi();
    await api.setWebhook(`${env("CONVEX_SITE_URL")}${WEBHOOK_PATH}`, {
      secret_token: env("TELEGRAM_WEBHOOK_SECRET"),
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
