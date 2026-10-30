// Minimal client bot for verifying a real deployment end to end. It asks the
// scheduler bot for a notification DELAY_SECONDS from now, then waits for it.
//
// Requires a second bot (the client) with Bot-to-Bot Communication Mode enabled,
// whose user id is listed in the scheduler's ALLOWED_BOT_IDS. Runs with long
// polling, so the client bot must not be used by anything else at the same time.
//
//   CLIENT_BOT_TOKEN=... SCHEDULER_BOT_USERNAME=my_scheduler_bot bun run demo-client

import { Bot } from "grammy";

const token = process.env.CLIENT_BOT_TOKEN;
const scheduler = process.env.SCHEDULER_BOT_USERNAME?.replace(/^@/, "");
const delaySeconds = Number(process.env.DELAY_SECONDS ?? 30);
if (!token || !scheduler) {
  console.error("Set CLIENT_BOT_TOKEN and SCHEDULER_BOT_USERNAME.");
  process.exit(1);
}

const bot = new Bot(token);
const taskId = crypto.randomUUID();
const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

bot.on("message:text", async (ctx) => {
  if (ctx.from.username?.toLowerCase() !== scheduler.toLowerCase()) return;
  console.log(`<- ${ctx.msg.text}`);
  if (ctx.msg.text === `/due ${taskId}`) {
    const lateBy = (Date.now() - Date.parse(runAt)) / 1000;
    console.log(`Success: notification arrived ${lateBy.toFixed(1)}s after the scheduled time.`);
    await bot.stop();
  } else if (ctx.msg.text.startsWith("error")) {
    console.error("Scheduler rejected the request.");
    await bot.stop();
    process.exitCode = 1;
  }
});

const me = await bot.api.getMe();
console.log(`Client bot @${me.username} (id ${me.id}); add this id to ALLOWED_BOT_IDS.`);

const text = `/schedule ${taskId} ${runAt}`;
await bot.api.sendMessage(`@${scheduler}`, text);
console.log(`-> ${text}`);

setTimeout(
  () => {
    console.error(
      `No notification ${delaySeconds + 60}s after the request; check \`bun run status\` and the Convex logs.`,
    );
    process.exit(1);
  },
  (delaySeconds + 60) * 1000,
).unref();

await bot.start({ allowed_updates: ["message"] });
