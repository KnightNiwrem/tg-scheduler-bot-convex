// End-to-end test against a LOCAL Convex deployment, with no Telegram account
// needed. A mock Bot API server records what the scheduler sends while the
// script posts fake webhook updates to the Convex HTTP action.
//
// Prerequisite (separate terminal): bunx convex dev --local   (or anonymous mode)
// Run: bun run e2e:local
//
// WARNING: overwrites the deployment's environment variables with test values,
// so it refuses to run against anything but a local deployment.

import { $ } from "bun";

const siteUrl = process.env.CONVEX_SITE_URL ?? "";
const deployment = process.env.CONVEX_DEPLOYMENT ?? "";
if (!/^(local|anonymous):/.test(deployment) || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(siteUrl)) {
  console.error(`Refusing to run: ${deployment || "no deployment"} (${siteUrl}) is not a local Convex deployment.`);
  process.exit(1);
}

const TOKEN = "123:test-token";
const SECRET = "test-secret";
const SCHEDULER = { id: 1000, is_bot: true, first_name: "Scheduler", username: "test_scheduler_bot" };
const CLIENT = { id: 2000, is_bot: true, first_name: "Client", username: "test_client_bot" };
const BROKEN_CLIENT = { id: 3000, is_bot: true, first_name: "Broken", username: "broken_client_bot" };
const RATE_LIMITED_CLIENT = { id: 5000, is_bot: true, first_name: "Busy", username: "busy_client_bot" };
const UNREACHABLE_CLIENT = { id: 7000, is_bot: true, first_name: "Gone", username: "gone_client_bot" };
const HUMAN = { id: 6000, is_bot: false, first_name: "Human" };
const STRANGER = { id: 4000, is_bot: true, first_name: "Stranger", username: "stranger_bot" };

// --- Mock Telegram Bot API -------------------------------------------------
type Sent = { chat_id: number; text: string };
const sent: Sent[] = [];
let rateLimited = false;
const mock = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop();
    const params = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (method === "getMe") return ok(SCHEDULER);
    if (method === "sendMessage") {
      const msg = { chat_id: Number(params.chat_id), text: String(params.text) };
      if (msg.chat_id === BROKEN_CLIENT.id && msg.text.startsWith("/due")) {
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" });
      }
      if (msg.chat_id === UNREACHABLE_CLIENT.id) {
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" });
      }
      if (msg.chat_id === RATE_LIMITED_CLIENT.id && msg.text.startsWith("/due") && !rateLimited) {
        rateLimited = true;
        return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
      }
      sent.push(msg);
      return ok({ message_id: sent.length, date: now(), chat: { id: msg.chat_id, type: "private" }, text: msg.text });
    }
    return Response.json({ ok: false, error_code: 404, description: `mock: ${method} not implemented` });
  },
});
const ok = (result: unknown) => Response.json({ ok: true, result });
const now = () => Math.floor(Date.now() / 1000);

// --- Helpers ----------------------------------------------------------------
let updateId = 1;
type Sender = { id: number; is_bot: boolean; first_name: string; username?: string };
async function postUpdate(from: Sender, text: string, secret = SECRET) {
  const res = await fetch(`${siteUrl}/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({
      update_id: updateId++,
      message: { message_id: updateId, date: now(), chat: { ...from, type: "private" }, from, text },
    }),
  });
  return res.status;
}

/** Waits until a message matching `predicate` was sent, or throws. */
async function waitForSent(predicate: (m: Sent) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sent.find(predicate);
    if (found) return found;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for message");
}

async function getSchedule(taskId: string) {
  const out = await $`bunx convex data schedules --format jsonLines --limit 1000`.quiet().text();
  return out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .find((doc) => doc.taskId === taskId);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// --- Test run ---------------------------------------------------------------
console.log(`Configuring ${deployment} to use mock Bot API at ${mock.url}`);
for (const [name, value] of Object.entries({
  BOT_TOKEN: TOKEN,
  BOT_WEBHOOK_SECRET: SECRET,
  ALLOWED_BOT_IDS: `${CLIENT.id},${BROKEN_CLIENT.id},${RATE_LIMITED_CLIENT.id},${UNREACHABLE_CLIENT.id}`,
  BOT_API_ROOT: mock.url.origin,
})) {
  await $`bunx convex env set ${name} ${value}`.quiet();
}

const taskId = crypto.randomUUID();
const runAt = new Date(Date.now() + 4000).toISOString();
const failingTaskId = crypto.randomUUID();
const retriedTaskId = crypto.randomUUID();

try {
  await check("rejects a request with a wrong webhook secret", async () => {
    const status = await postUpdate(CLIENT, `/schedule ${taskId} ${runAt}`, "wrong");
    assert(status === 401, `expected 401, got ${status}`);
  });

  await check("ignores unauthorized bots without replying", async () => {
    const status = await postUpdate(STRANGER, `/schedule ${crypto.randomUUID()} ${runAt}`);
    assert(status === 200, `expected 200, got ${status}`);
    await Bun.sleep(500);
    assert(!sent.some((m) => m.chat_id === STRANGER.id), "replied to an unauthorized bot");
  });

  await check("ignores non-command messages from authorized bots", async () => {
    await postUpdate(CLIENT, "hello there");
    await Bun.sleep(500);
    assert(sent.length === 0, `unexpected reply: ${sent[0]?.text}`);
  });

  await check("rejects an invalid request with an error reply", async () => {
    await postUpdate(CLIENT, `/schedule not-a-uuid ${runAt}`);
    await waitForSent((m) => m.text.startsWith("error invalid_task_id"));
  });

  await check("acknowledges a valid request", async () => {
    await postUpdate(CLIENT, `/schedule ${taskId} ${runAt}`);
    const ack = await waitForSent((m) => m.text.startsWith(`scheduled ${taskId}`));
    assert(ack.chat_id === CLIENT.id, "ack sent to wrong chat");
    assert(ack.text === `scheduled ${taskId} ${runAt}`, `unexpected ack: ${ack.text}`);
  });

  await check("treats a repeated request as idempotent", async () => {
    const before = sent.filter((m) => m.text.startsWith(`scheduled ${taskId}`)).length;
    await postUpdate(CLIENT, `/schedule ${taskId} ${runAt}`);
    await waitForSent(() => sent.filter((m) => m.text.startsWith(`scheduled ${taskId}`)).length > before);
  });

  await check("rejects the same task id with a different time", async () => {
    const otherTime = new Date(Date.parse(runAt) + 60_000).toISOString();
    await postUpdate(CLIENT, `/schedule ${taskId} ${otherTime}`);
    await waitForSent((m) => m.text.startsWith(`error conflict task ${taskId}`));
  });

  await check("acknowledges an update to Telegram even if handling it throws", async () => {
    // The ack reply fails with 403, so the update handler throws.
    const status = await postUpdate(UNREACHABLE_CLIENT, `/schedule ${crypto.randomUUID()} ${runAt}`);
    assert(status === 200, `expected 200, got ${status}`);
  });

  await check("schedules tasks whose delivery will fail", async () => {
    await postUpdate(BROKEN_CLIENT, `/schedule ${failingTaskId} ${runAt}`);
    await waitForSent((m) => m.text.startsWith(`scheduled ${failingTaskId}`));
    await postUpdate(RATE_LIMITED_CLIENT, `/schedule ${retriedTaskId} ${runAt}`);
    await waitForSent((m) => m.text.startsWith(`scheduled ${retriedTaskId}`));
  });

  await check("delivers /due exactly once when the time arrives", async () => {
    const due = await waitForSent((m) => m.text === `/due ${taskId}`, 15_000);
    assert(due.chat_id === CLIENT.id, "notification sent to wrong chat");
    assert(Date.now() >= Date.parse(runAt), "notification sent too early");
    await Bun.sleep(1500);
    const count = sent.filter((m) => m.text === `/due ${taskId}`).length;
    assert(count === 1, `expected 1 notification, got ${count}`);
    const doc = await getSchedule(taskId);
    assert(doc?.status === "delivered" && doc.attempts === 1, `unexpected record: ${JSON.stringify(doc)}`);
  });

  await check("marks a permanently failing delivery as failed without retrying", async () => {
    const doc = await getSchedule(failingTaskId);
    assert(doc?.status === "failed" && doc.attempts === 1, `unexpected record: ${JSON.stringify(doc)}`);
    assert(String(doc.lastError).includes("403"), `unexpected error: ${doc.lastError}`);
  });

  await check("retries a rate-limited delivery after retry_after", async () => {
    await waitForSent((m) => m.text === `/due ${retriedTaskId}`, 10_000);
    assert(rateLimited, "the first attempt was not rate limited");
    const doc = await getSchedule(retriedTaskId);
    assert(doc?.status === "delivered" && doc.attempts === 2, `unexpected record: ${JSON.stringify(doc)}`);
  });

  await check("ALLOWED_BOT_IDS=* accepts any bot but not human users", async () => {
    await $`bunx convex env set ALLOWED_BOT_IDS ${"*"}`.quiet(); // interpolated so the shell does not glob it
    const strangerTaskId = crypto.randomUUID();
    const later = new Date(Date.now() + 60_000).toISOString();
    await postUpdate(STRANGER, `/schedule ${strangerTaskId} ${later}`);
    await waitForSent((m) => m.chat_id === STRANGER.id && m.text.startsWith(`scheduled ${strangerTaskId}`));
    await postUpdate(HUMAN, `/schedule ${crypto.randomUUID()} ${later}`);
    await Bun.sleep(500);
    assert(!sent.some((m) => m.chat_id === HUMAN.id), "replied to a human user");
  });
} finally {
  mock.stop(true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log("Note: the local deployment now has test env vars; set real ones before using it with Telegram.");
process.exit(failures ? 1 : 0);
