# tg-scheduler-bot-convex

A Telegram bot that schedules one-time notifications for **other Telegram bots**.
A client bot sends the scheduler bot a private message with a task UUID and a time.
When that time arrives, the scheduler sends the UUID back to the client bot. What the
client does with it is up to the client.

The whole backend runs on [Convex](https://convex.dev): the Telegram webhook is a Convex
HTTP action, schedules are stored in the Convex database, and delivery runs as a Convex
scheduled function. Telegram handling uses [grammY](https://grammy.dev). You don't need a
VPS, Redis, or a job queue.

```
client bot ──/schedule <uuid> <time>──▶ scheduler bot ──webhook──▶ Convex HTTP action
           ◀──scheduled <uuid> <time>──                                │ store + ctx.scheduler.runAt
           ◀──────/due <uuid>────────── Convex scheduled action ◀──────┘ (at <time>)
```

## Protocol

All messages are plain text in the private chat between the client bot and the scheduler bot.

| Direction | Message | Example |
|---|---|---|
| client → scheduler | `/schedule <task-uuid> <time>` | `/schedule 8c7e3f7a-1b2c-4d5e-9f00-112233445566 2026-11-01T09:30:00Z` |
| scheduler → client | `scheduled <task-uuid> <time in UTC>` | `scheduled 8c7e3f7a-… 2026-11-01T09:30:00.000Z` |
| scheduler → client | `error <code> <detail>` | `error time_in_past time must be in the future` |
| scheduler → client, at `<time>` | `/due <task-uuid>` | `/due 8c7e3f7a-1b2c-4d5e-9f00-112233445566` |

- `<time>` must be ISO 8601 and must include an offset: `Z` or `±HH:MM`. Seconds and milliseconds
  are optional. The time must be in the future and no more than 366 days ahead.
- Replies are sent as replies to the request message, so you can match them by `reply_to_message`
  as well as by UUID.
- **Idempotency:** a schedule is identified by (client bot, task UUID). Sending the same request again
  returns the same `scheduled` ack and does not create a second notification. Sending the same UUID
  with a different time returns `error conflict`.
- Error codes: `invalid_request`, `invalid_task_id`, `invalid_time`, `time_in_past`, `time_too_far`,
  `conflict`, `internal` (the request may be retried).
- The scheduler doesn't reply to messages from bots that aren't on the allowlist, or to any message
  that isn't a `/schedule` command. That keeps two bots from getting stuck replying to each other.

A minimal grammY client:

```ts
await bot.api.sendMessage("@your_scheduler_bot", `/schedule ${taskId} ${runAt.toISOString()}`);

bot.hears(/^\/due ([0-9a-f-]{36})$/, async (ctx) => {
  const taskId = ctx.match[1];
  // run the task
});
```

## Setup

You need [Bun](https://bun.sh), a [Convex](https://convex.dev) account (the free tier is enough), and
two bots from [@BotFather](https://t.me/BotFather): the scheduler, and a client to test with.

1. **Enable Bot-to-Bot Communication Mode** in @BotFather for **both** bots. Telegram only delivers
   private messages between two bots when both have this mode on
   ([docs](https://core.telegram.org/bots/features#bot-to-bot-communication)).

2. **Install and create a Convex deployment:**

   ```sh
   bun install
   bunx convex dev        # log in, create a project, push functions; keep it running or Ctrl+C after "ready"
   ```

3. **Configure the deployment** (these values are stored in Convex, not in local files):

   ```sh
   bunx convex env set TELEGRAM_BOT_TOKEN '<scheduler bot token>'
   bunx convex env set TELEGRAM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
   bunx convex env set ALLOWED_BOT_IDS '<client bot id>,<another bot id>'
   ```

   A bot's numeric id is the part of its token before the `:`. The demo client also prints it.
   The allowlist is checked against the sender's Telegram user id. For a quick manual test you
   can add your own user id and send `/schedule …` to the scheduler from your Telegram app.

4. **Register the webhook.** The URL is built from the deployment's `CONVEX_SITE_URL`:

   ```sh
   bun run set-webhook    # prints getWebhookInfo; url should end in /telegram/webhook
   ```

### Production

`bunx convex dev` deploys to your personal dev deployment. For production, run the same steps with `--prod`:

```sh
bunx convex deploy
bunx convex env set --prod TELEGRAM_BOT_TOKEN '…'   # and the other two variables
bunx convex run --prod telegram:setWebhook
```

Use a different bot token for dev and prod. A bot can only have one webhook, so whichever deployment
ran `setWebhook` last receives that bot's updates.

## Verifying

**Against Telegram** (after setup):

```sh
bun run status                                      # bot identity + webhook health (pending updates, last error)
CLIENT_BOT_TOKEN='<client bot token>' SCHEDULER_BOT_USERNAME=your_scheduler_bot bun run demo-client
```

The demo client schedules a task 30 seconds out (`DELAY_SECONDS` changes this), prints the ack, and
exits with `Success` when `/due <uuid>` arrives. It uses long polling, so stop any other process
that uses the client bot first. The Convex dashboard shows each request in the `schedules` table.
Pending runs appear in the Functions view as scheduled functions.

**Locally, without Telegram:**

```sh
# terminal 1: a local Convex backend. Without a Convex account:
CONVEX_AGENT_MODE=anonymous bunx convex dev
# ...or with an existing project: bunx convex deployment select local && bunx convex dev

# terminal 2
bun run e2e:local
```

`e2e:local` starts a mock Bot API server, points the local deployment at it with `TELEGRAM_API_ROOT`,
and posts webhook updates to the HTTP action. It checks secret validation, the allowlist, error
replies, idempotency, conflicts, on-time delivery, permanent failures, and a rate-limit retry. It
overwrites the deployment's environment variables, so it refuses to run against non-local deployments.

Other checks: `bun test` (protocol parsing) and `bun run typecheck`.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Scheduler bot token |
| `TELEGRAM_WEBHOOK_SECRET` | yes | 1–256 chars of `A-Z a-z 0-9 _ -`. Telegram sends it with every update, and requests without it get a 401 |
| `ALLOWED_BOT_IDS` | yes | Comma-separated Telegram user ids allowed to schedule |
| `TELEGRAM_API_ROOT` | no | Bot API base URL, e.g. a [local Bot API server](https://github.com/tdlib/telegram-bot-api). Defaults to `https://api.telegram.org` |

## How it works

| File | Purpose |
|---|---|
| `convex/http.ts` | `POST /telegram/webhook`. Checks the secret token, then hands the request to grammY's `webhookCallback` (the `std/http` adapter takes a `Request` and returns a `Response`, which is what Convex HTTP actions use). |
| `convex/bot.ts` | grammY bot. Checks the allowlist, parses `/schedule`, stores the schedule, and replies. |
| `convex/protocol.ts` | Message parsing and formatting, as pure functions. |
| `convex/schedules.ts` | `create` mutation (idempotent insert plus `ctx.scheduler.runAt`), and the `deliver` action with its state transitions. |
| `convex/telegram.ts` | Config helpers, plus the `setWebhook` and `status` actions. |

Each schedule moves through `pending → sending → delivered`. If a send fails with a transient error
(network, Telegram 5xx, or 429, which honors `retry_after`), the schedule goes back to `pending` and is
retried, up to 3 attempts in total. If it fails with a permanent error (for example 403 because the
client blocked the scheduler), it is marked `failed` with `lastError`.

## Trade-offs and limitations (first iteration)

- **At-most-once delivery.** Convex doesn't retry scheduled actions automatically. The `deliver` action
  moves the schedule to `sending` in a mutation before calling Telegram, so a notification is never
  sent twice. The cost: if the action crashes after that claim but before the outcome is recorded, the
  schedule stays in `sending` and is not sent. A periodic sweeper for stuck `sending` rows can come
  later as part of delivery reliability work.
- **Failed updates are acknowledged.** If handling an update throws, the error is logged and Telegram
  still gets a 200. Otherwise Telegram would redeliver the same update indefinitely and hold back
  later ones. Clients that get no ack should resend the request. Resending is safe because requests
  are idempotent.
- **Precision.** In local testing, delivery ran within about a second of the scheduled time. Telegram
  delivery adds some latency on top of that, and sub-second precision isn't guaranteed.
- **Notifications go to the chat id.** Acks and `/due` are sent to the client bot's numeric id, which
  is also the id of its private chat. Telegram's docs describe *starting* a bot-to-bot chat with
  `@username`. This service only sends in chats the client has already started, so a username change
  doesn't break delivery.
- **Trust model.** Bots on the allowlist are trusted. There is no per-client quota or rate limit yet,
  and an allowlisted bot can create as many schedules as Convex allows (1M outstanding scheduled
  functions per deployment).
- **A new bot instance per request.** Each webhook request builds a new grammY `Bot`. Bot info from `getMe`
  is cached while Convex reuses the isolate, so most updates don't need an extra API call.

Not in this iteration: recurring/cron schedules, cancel or list commands, admin commands, and stronger
delivery guarantees.

## License

MIT
