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
if (
  !/^(local|anonymous):/.test(deployment) ||
  !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(siteUrl)
) {
  console.error(
    `Refusing to run: ${deployment || "no deployment"} (${siteUrl}) is not a local Convex deployment.`,
  );
  process.exit(1);
}

const TOKEN = "123:test-token";
const SECRET = "test-secret";
const SCHEDULER = {
  id: 1000,
  is_bot: true,
  first_name: "Scheduler",
  username: "test_scheduler_bot",
};
const CLIENT = { id: 2000, is_bot: true, first_name: "Client", username: "test_client_bot" };
const BROKEN_CLIENT = {
  id: 3000,
  is_bot: true,
  first_name: "Broken",
  username: "broken_client_bot",
};
const RATE_LIMITED_CLIENT = {
  id: 5000,
  is_bot: true,
  first_name: "Busy",
  username: "busy_client_bot",
};
const UNREACHABLE_CLIENT = {
  id: 7000,
  is_bot: true,
  first_name: "Gone",
  username: "gone_client_bot",
};
// Random id, so active crons left over from an earlier run do not count against its quota.
const BUSY_CRON_CLIENT = {
  id: 80_000 + Math.floor(Math.random() * 10_000),
  is_bot: true,
  first_name: "Many",
  username: "many_crons_bot",
};
const HUMAN = { id: 6000, is_bot: false, first_name: "Human" };
const STRANGER = { id: 4000, is_bot: true, first_name: "Stranger", username: "stranger_bot" };

// --- Mock Telegram Bot API -------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: test messages are checked field by field
type Message = Record<string, any>;
type Sent = { chat_id: number; text: string; json: Message };
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
      const text = String(params.text);
      const msg = { chat_id: Number(params.chat_id), text, json: JSON.parse(text) };
      if (msg.chat_id === BROKEN_CLIENT.id && msg.json.type === "due") {
        return Response.json({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked",
        });
      }
      if (msg.chat_id === UNREACHABLE_CLIENT.id) {
        return Response.json({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked",
        });
      }
      if (msg.chat_id === RATE_LIMITED_CLIENT.id && msg.json.type === "due" && !rateLimited) {
        rateLimited = true;
        return Response.json({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        });
      }
      sent.push(msg);
      return ok({
        message_id: sent.length,
        date: now(),
        chat: { id: msg.chat_id, type: "private" },
        text: msg.text,
      });
    }
    return Response.json({
      ok: false,
      error_code: 404,
      description: `mock: ${method} not implemented`,
    });
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
      message: {
        message_id: updateId,
        date: now(),
        chat: { ...from, type: "private" },
        from,
        text,
      },
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

type Request = { type: string; requestId?: string; [field: string]: unknown };
/** Sends a request (with a new request id unless it has one). Returns the request id. */
async function request(from: Sender, fields: Request) {
  const requestId = fields.requestId ?? crypto.randomUUID();
  await postUpdate(from, JSON.stringify({ ...fields, requestId }));
  return requestId;
}
const replies = (requestId: string) => sent.filter((m) => m.json.requestId === requestId);
/** Waits for the `n`th reply to a request id. */
async function reply(requestId: string, n = 1, timeoutMs = 5000) {
  await waitForSent(() => replies(requestId).length >= n, timeoutMs);
  return replies(requestId)[n - 1] as Sent;
}
async function expectAck(requestId: string, n = 1) {
  const m = await reply(requestId, n);
  assert(m.json.type === "ack", `expected an ack, got ${m.text}`);
  return m;
}
async function expectError(requestId: string, code: string, n = 1) {
  const m = await reply(requestId, n);
  assert(m.json.type === "error" && m.json.code === code, `expected error ${code}, got ${m.text}`);
  return m;
}
const schedule = (taskId: string, runAt: string, requestId?: string) =>
  ({ type: "schedule", requestId, taskId, runAt }) as Request;
const cron = (taskId: string, spec: string, requestId?: string) =>
  ({ type: "cron", requestId, taskId, cron: spec }) as Request;
const cancel = (taskId: string, requestId?: string) =>
  ({ type: "cancel", requestId, taskId }) as Request;

async function getDocs(table: string, component?: string) {
  const args = component ? ["--component", component] : [];
  const out = await $`bunx convex data ${table} ${args} --format jsonLines --limit 1000`
    .quiet()
    .text();
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const getSchedule = async (taskId: string) =>
  (await getDocs("schedules")).find((doc) => doc.taskId === taskId);
const getRecurring = async (taskId: string) =>
  (await getDocs("recurring")).find((doc) => doc.taskId === taskId);
const dues = (taskId: string) =>
  sent.filter((m) => m.json.type === "due" && m.json.taskId === taskId);
const countDue = (taskId: string) => dues(taskId).length;
/** Number of crons registered in the crons component for a recurring schedule. */
const countCrons = async (recurringId: string) =>
  (await getDocs("crons", "crons")).filter((c) => c.args.recurringId === recurringId).length;

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
  ALLOWED_BOT_IDS: [
    CLIENT,
    BROKEN_CLIENT,
    RATE_LIMITED_CLIENT,
    UNREACHABLE_CLIENT,
    BUSY_CRON_CLIENT,
  ]
    .map((c) => c.id)
    .join(","),
  BOT_API_ROOT: mock.url.origin,
})) {
  await $`bunx convex env set ${name} ${value}`.quiet();
}

const taskId = crypto.randomUUID();
const runAt = new Date(Date.now() + 4000).toISOString();
const failingTaskId = crypto.randomUUID();
const retriedTaskId = crypto.randomUUID();
const cancelledTaskId = crypto.randomUUID();
const cronTaskId = crypto.randomUUID();
const cancelledCronTaskId = crypto.randomUUID();
const failingCronTaskId = crypto.randomUUID();
const EVERY_MINUTE = "* * * * *";
let cancelledRunAt = "";
let scheduleRequestId = "";

try {
  await check("rejects a request with a wrong webhook secret", async () => {
    const body = JSON.stringify({ ...schedule(taskId, runAt), requestId: crypto.randomUUID() });
    const status = await postUpdate(CLIENT, body, "wrong");
    assert(status === 401, `expected 401, got ${status}`);
  });

  await check("ignores unauthorized bots without replying", async () => {
    const status = await postUpdate(
      STRANGER,
      JSON.stringify({ ...schedule(crypto.randomUUID(), runAt), requestId: crypto.randomUUID() }),
    );
    assert(status === 200, `expected 200, got ${status}`);
    await Bun.sleep(500);
    assert(!sent.some((m) => m.chat_id === STRANGER.id), "replied to an unauthorized bot");
  });

  await check("ignores messages that are not requests", async () => {
    for (const text of [
      "hello there",
      `/schedule ${taskId} ${runAt}`, // the old text protocol
      '{"type":"schedule",', // malformed JSON
      JSON.stringify({ type: "due", taskId }),
      JSON.stringify({ type: "something_else", requestId: crypto.randomUUID() }),
    ]) {
      await postUpdate(CLIENT, text);
    }
    await Bun.sleep(500);
    assert(sent.length === 0, `unexpected reply: ${sent[0]?.text}`);
  });

  await check("rejects an invalid request with an error reply", async () => {
    const requestId = await request(CLIENT, schedule("not-a-uuid", runAt));
    await expectError(requestId, "invalid_task_id");
    await postUpdate(CLIENT, JSON.stringify(schedule(taskId, runAt))); // no request id
    await waitForSent((m) => m.json.code === "invalid_request_id" && m.json.requestId === null);
  });

  await check("acknowledges a valid request", async () => {
    scheduleRequestId = await request(CLIENT, schedule(taskId, runAt));
    const ack = await expectAck(scheduleRequestId);
    assert(ack.chat_id === CLIENT.id, "ack sent to wrong chat");
    const expected = { type: "ack", requestId: scheduleRequestId, op: "schedule", taskId, runAt };
    assert(ack.text === JSON.stringify(expected), `unexpected ack: ${ack.text}`);
  });

  await check("replays the same ack for a repeated request id", async () => {
    await request(CLIENT, schedule(taskId, runAt, scheduleRequestId));
    const again = await reply(scheduleRequestId, 2);
    assert(again.text === replies(scheduleRequestId)[0]?.text, `ack differs: ${again.text}`);
  });

  await check("acks the same schedule sent with a new request id", async () => {
    const requestId = await request(CLIENT, schedule(taskId, runAt));
    const ack = await expectAck(requestId);
    assert(ack.json.runAt === runAt, `unexpected ack: ${ack.text}`);
    assert(
      (await getDocs("schedules")).filter((d) => d.taskId === taskId).length === 1,
      "stored a second schedule",
    );
  });

  await check("rejects a request id reused for a different request", async () => {
    const otherTime = new Date(Date.parse(runAt) + 60_000).toISOString();
    await request(CLIENT, schedule(crypto.randomUUID(), otherTime, scheduleRequestId));
    await expectError(scheduleRequestId, "request_id_reused", 3);
  });

  await check("rejects the same task id with a different time", async () => {
    const otherTime = new Date(Date.parse(runAt) + 60_000).toISOString();
    const requestId = await request(CLIENT, schedule(taskId, otherTime));
    const error = await expectError(requestId, "conflict");
    assert(error.json.detail.startsWith(`task ${taskId}`), `unexpected error: ${error.text}`);
  });

  await check("rejects a time in the past", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await expectError(await request(CLIENT, schedule(crypto.randomUUID(), past)), "time_in_past");
  });

  await check("acknowledges an update to Telegram even if handling it throws", async () => {
    // The ack reply fails with 403, so the update handler throws.
    const status = await postUpdate(
      UNREACHABLE_CLIENT,
      JSON.stringify({ ...schedule(crypto.randomUUID(), runAt), requestId: crypto.randomUUID() }),
    );
    assert(status === 200, `expected 200, got ${status}`);
  });

  await check("schedules tasks whose delivery will fail", async () => {
    await expectAck(await request(BROKEN_CLIENT, schedule(failingTaskId, runAt)));
    await expectAck(await request(RATE_LIMITED_CLIENT, schedule(retriedTaskId, runAt)));
  });

  await check("delivers due exactly once when the time arrives", async () => {
    const due = await waitForSent((m) => m.json.type === "due" && m.json.taskId === taskId, 15_000);
    assert(due.chat_id === CLIENT.id, "notification sent to wrong chat");
    assert(Date.now() >= Date.parse(runAt), "notification sent too early");
    const expected = { type: "due", deliveryId: `${taskId}@${runAt}`, taskId, scheduledFor: runAt };
    assert(due.text === JSON.stringify(expected), `unexpected notification: ${due.text}`);
    await Bun.sleep(1500);
    assert(countDue(taskId) === 1, `expected 1 notification, got ${countDue(taskId)}`);
    const doc = await getSchedule(taskId);
    assert(
      doc?.status === "delivered" && doc.attempts === 1,
      `unexpected record: ${JSON.stringify(doc)}`,
    );
  });

  await check("acks a repeated request after its time has passed", async () => {
    await request(CLIENT, schedule(taskId, runAt, scheduleRequestId));
    const replayed = await reply(scheduleRequestId, 4);
    assert(replayed.text === replies(scheduleRequestId)[0]?.text, `got ${replayed.text}`);
    await expectAck(await request(CLIENT, schedule(taskId, runAt)));
  });

  await check("acknowledges a recurring request and treats a repeat as idempotent", async () => {
    const requestId = await request(CLIENT, cron(cronTaskId, EVERY_MINUTE));
    const ack = await expectAck(requestId);
    const expected = { type: "ack", requestId, op: "cron", taskId: cronTaskId, cron: EVERY_MINUTE };
    assert(ack.text === JSON.stringify(expected), `unexpected ack: ${ack.text}`);
    const again = await request(CLIENT, cron(cronTaskId, ` ${EVERY_MINUTE.replace(" ", "  ")}`));
    await expectAck(again);
    const doc = await getRecurring(cronTaskId);
    const crons = await countCrons(doc?._id);
    assert(crons === 1, `expected 1 registered cron, got ${crons}`);
  });

  await check("rejects crons that are invalid or more frequent than once a minute", async () => {
    const seconds = await request(CLIENT, cron(crypto.randomUUID(), "*/5 * * * * *"));
    const error = await expectError(seconds, "invalid_cron");
    assert(error.json.detail.startsWith("cron must have 5 fields"), `got ${error.text}`);
    const never = await request(CLIENT, cron(crypto.randomUUID(), "0 0 30 2 *"));
    const error2 = await expectError(never, "invalid_cron");
    assert(error2.json.detail === 'cron "0 0 30 2 *" is not valid', `got ${error2.text}`);
  });

  await check("rejects a task id reused across one-time and recurring schedules", async () => {
    const r1 = await request(CLIENT, cron(cronTaskId, "0 * * * *"));
    const e1 = await expectError(r1, "conflict");
    assert(e1.json.detail.includes("is already scheduled as cron"), `got ${e1.text}`);
    const later = new Date(Date.now() + 60_000).toISOString();
    await expectError(await request(CLIENT, schedule(cronTaskId, later)), "conflict");
    const e3 = await expectError(await request(CLIENT, cron(taskId, EVERY_MINUTE)), "conflict");
    assert(e3.json.detail.includes(`is already scheduled for ${runAt}`), `got ${e3.text}`);
  });

  await check("cancels a pending one-time schedule", async () => {
    cancelledRunAt = new Date(Date.now() + 3000).toISOString();
    const scheduled = await request(CLIENT, schedule(cancelledTaskId, cancelledRunAt));
    await expectAck(scheduled);
    const cancelled = await request(CLIENT, cancel(cancelledTaskId));
    const ack = await expectAck(cancelled);
    assert(ack.json.op === "cancel" && ack.json.taskId === cancelledTaskId, `got ${ack.text}`);
    // A new request for the cancelled task conflicts...
    const fresh = await request(CLIENT, schedule(cancelledTaskId, cancelledRunAt));
    const error = await expectError(fresh, "conflict");
    assert(error.json.detail.endsWith("(cancelled)"), `unexpected error: ${error.text}`);
    // ...but a retry of the original request gets its original ack.
    await request(CLIENT, schedule(cancelledTaskId, cancelledRunAt, scheduled));
    const replayed = await reply(scheduled, 2);
    assert(replayed.text === replies(scheduled)[0]?.text, `got ${replayed.text}`);
  });

  await check("cancels a recurring schedule and removes its cron", async () => {
    await expectAck(await request(CLIENT, cron(cancelledCronTaskId, EVERY_MINUTE)));
    await expectAck(await request(CLIENT, cancel(cancelledCronTaskId)));
    await expectAck(await request(CLIENT, cancel(cancelledCronTaskId))); // idempotent
    const doc = await getRecurring(cancelledCronTaskId);
    assert(doc?.status === "cancelled", `unexpected record: ${JSON.stringify(doc)}`);
    assert((await countCrons(doc._id)) === 0, "cron is still registered");
  });

  await check("reports unknown tasks on cancel", async () => {
    const unknown = crypto.randomUUID();
    const error = await expectError(await request(CLIENT, cancel(unknown)), "not_found");
    assert(error.json.detail === `no schedule for task ${unknown}`, `got ${error.text}`);
  });

  await check("limits the number of active recurring schedules per client", async () => {
    const LIMIT = 50;
    const requestIds: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      // Once a year, so these never fire during the test.
      requestIds.push(await request(BUSY_CRON_CLIENT, cron(crypto.randomUUID(), "0 0 1 1 *")));
    }
    await waitForSent(() => requestIds.every((id) => replies(id)[0]?.json.type === "ack"), 30_000);
    const extra = crypto.randomUUID();
    const rejected = await request(BUSY_CRON_CLIENT, cron(extra, "0 0 1 1 *"));
    await expectError(rejected, "quota_exceeded");
    // Cancelling one frees a slot.
    const first = (await getDocs("recurring")).find(
      (d) => d.clientId === BUSY_CRON_CLIENT.id && d.status === "active",
    );
    await expectAck(await request(BUSY_CRON_CLIENT, cancel(first.taskId)));
    // Errors are not stored, so the rejected request can be retried with the same id.
    await request(BUSY_CRON_CLIENT, cron(extra, "0 0 1 1 *", rejected));
    const ack = await reply(rejected, 2);
    assert(ack.json.type === "ack", `expected an ack, got ${ack.text}`);
  });

  await check("schedules a recurring task whose delivery will fail", async () => {
    await expectAck(await request(BROKEN_CLIENT, cron(failingCronTaskId, EVERY_MINUTE)));
  });

  await check("does not deliver a cancelled one-time schedule", async () => {
    await Bun.sleep(Math.max(0, Date.parse(cancelledRunAt) + 2000 - Date.now()));
    assert(countDue(cancelledTaskId) === 0, "cancelled schedule was delivered");
    const doc = await getSchedule(cancelledTaskId);
    assert(
      doc?.status === "cancelled" && doc.attempts === 0,
      `unexpected record: ${JSON.stringify(doc)}`,
    );
  });

  await check("marks a permanently failing delivery as failed without retrying", async () => {
    const doc = await getSchedule(failingTaskId);
    assert(
      doc?.status === "failed" && doc.attempts === 1,
      `unexpected record: ${JSON.stringify(doc)}`,
    );
    assert(String(doc.lastError).includes("403"), `unexpected error: ${doc.lastError}`);
  });

  await check("retries a rate-limited delivery after retry_after", async () => {
    await waitForSent((m) => m.json.type === "due" && m.json.taskId === retriedTaskId, 10_000);
    assert(rateLimited, "the first attempt was not rate limited");
    const doc = await getSchedule(retriedTaskId);
    assert(
      doc?.status === "delivered" && doc.attempts === 2,
      `unexpected record: ${JSON.stringify(doc)}`,
    );
  });

  console.log("  ...   waiting up to two minutes for cron runs");

  await check("delivers a recurring schedule on every minute boundary", async () => {
    for (const n of [1, 2]) {
      await waitForSent(() => countDue(cronTaskId) === n, 70_000);
      const second = new Date().getUTCSeconds();
      assert(second < 10, `run ${n} arrived ${second}s past the minute`);
    }
    const [first, second] = dues(cronTaskId).map((m) => m.json);
    for (const due of [first, second]) {
      assert(
        due?.scheduledFor.endsWith(":00.000Z") &&
          due.deliveryId === `${cronTaskId}@${due.scheduledFor}`,
        `unexpected notification: ${JSON.stringify(due)}`,
      );
    }
    assert(
      Date.parse(second?.scheduledFor) - Date.parse(first?.scheduledFor) === 60_000,
      "runs are not one minute apart",
    );
    const doc = await getRecurring(cronTaskId);
    assert(
      doc?.status === "active" &&
        doc.lastDeliveredAt &&
        doc.lastRunFor === Date.parse(second?.scheduledFor),
      `unexpected record: ${JSON.stringify(doc)}`,
    );
  });

  await check("does not run a cancelled recurring schedule", async () => {
    assert(countDue(cancelledCronTaskId) === 0, "cancelled cron was delivered");
  });

  await check("stops a recurring schedule after a permanent delivery error", async () => {
    // Its first run can fall on the same minute as the second run above.
    let doc = await getRecurring(failingCronTaskId);
    for (
      const deadline = Date.now() + 70_000;
      doc?.status === "active" && Date.now() < deadline;
    ) {
      await Bun.sleep(1000);
      doc = await getRecurring(failingCronTaskId);
    }
    assert(
      doc?.status === "failed" && String(doc.lastError).includes("403"),
      `unexpected record: ${JSON.stringify(doc)}`,
    );
    assert((await countCrons(doc._id)) === 0, "cron of the failed schedule is still registered");
  });

  await check("stops recurring delivery after cancel", async () => {
    await expectAck(await request(CLIENT, cancel(cronTaskId)));
    const doc = await getRecurring(cronTaskId);
    assert(doc?.status === "cancelled", `unexpected record: ${JSON.stringify(doc)}`);
    assert((await countCrons(doc._id)) === 0, "cron is still registered");
  });

  await check("ALLOWED_BOT_IDS=* accepts any bot but not human users", async () => {
    await $`bunx convex env set ALLOWED_BOT_IDS ${"*"}`.quiet(); // interpolated so the shell does not glob it
    const later = new Date(Date.now() + 60_000).toISOString();
    const requestId = await request(STRANGER, schedule(crypto.randomUUID(), later));
    const ack = await expectAck(requestId);
    assert(ack.chat_id === STRANGER.id, "ack sent to wrong chat");
    await request(HUMAN, schedule(crypto.randomUUID(), later));
    await Bun.sleep(500);
    assert(!sent.some((m) => m.chat_id === HUMAN.id), "replied to a human user");
  });
} finally {
  mock.stop(true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(
  "Note: the local deployment now has test env vars; set real ones before using it with Telegram.",
);
process.exit(failures ? 1 : 0);
