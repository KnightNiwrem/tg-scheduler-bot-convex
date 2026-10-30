// Wire protocol between client bots and the scheduler bot. Every message is a
// single JSON object in the private chat, discriminated by `type`. Pure
// functions only, so this module can be unit tested outside of Convex.
//
//   client -> scheduler
//     {"type":"schedule","requestId":"<uuid>","taskId":"<uuid>","runAt":"<ISO 8601>"}
//     {"type":"cron","requestId":"<uuid>","taskId":"<uuid>","cron":"<5-field cron>"}
//     {"type":"cancel","requestId":"<uuid>","taskId":"<uuid>"}
//   scheduler -> client
//     {"type":"ack","requestId":"<uuid>","op":"schedule","taskId":"<uuid>","runAt":"<ISO UTC>"}
//     {"type":"ack","requestId":"<uuid>","op":"cron","taskId":"<uuid>","cron":"<cron>"}
//     {"type":"ack","requestId":"<uuid>","op":"cancel","taskId":"<uuid>"}
//     {"type":"error","requestId":"<uuid>"|null,"code":"<code>","detail":"<text>"}
//     {"type":"due","deliveryId":"<id>","taskId":"<uuid>","scheduledFor":"<ISO UTC>"}

import parser from "cron-parser";

export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_CRON_LENGTH = 100;

export type RequestType = "schedule" | "cron" | "cancel";
const REQUEST_TYPES: readonly string[] = ["schedule", "cron", "cancel"] satisfies RequestType[];

export type ErrorCode =
  | "invalid_request_id"
  | "invalid_task_id"
  | "invalid_time"
  | "time_in_past"
  | "time_too_far"
  | "invalid_cron"
  | "conflict"
  | "request_id_reused"
  | "not_found"
  | "quota_exceeded"
  | "internal";

/** A validated request. Ids are lowercased, times are epoch milliseconds, cron whitespace is normalized. */
export type Request =
  | { type: "schedule"; requestId: string; taskId: string; runAt: number }
  | { type: "cron"; requestId: string; taskId: string; cronspec: string }
  | { type: "cancel"; requestId: string; taskId: string };

export type ParseResult =
  | { kind: "request"; request: Request }
  | { kind: "invalid"; requestId: string | null; code: ErrorCode; detail: string }
  // Not addressed to the scheduler. Ignored without a reply, so two bots
  // cannot get stuck replying to each other.
  | { kind: "ignored" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO 8601 date-time with a mandatory UTC offset, e.g. 2026-11-01T09:30:00Z
// or 2026-11-01T17:30:00+08:00. Seconds and milliseconds are optional.
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

/**
 * Parses a message from a client bot. Only a JSON object whose `type` is a
 * request type gets a reply; anything else, including the scheduler's own
 * message types and malformed JSON, is ignored. Unknown fields are ignored.
 *
 * Checks that depend on the current time (`time_in_past`, `time_too_far`) are
 * not done here: a retried request must get its original ack even after its
 * time has passed, so they run after the duplicate checks (see checkRunAt).
 */
export function parseRequest(text: string): ParseResult {
  const fields = parseObject(text);
  const type = fields?.type;
  if (!fields || typeof type !== "string" || !REQUEST_TYPES.includes(type)) {
    return { kind: "ignored" };
  }

  if (!isUuid(fields.requestId)) {
    return invalid(null, "invalid_request_id", "requestId must be a UUID");
  }
  const requestId = fields.requestId.toLowerCase();
  if (!isUuid(fields.taskId)) {
    return invalid(requestId, "invalid_task_id", "taskId must be a UUID");
  }
  const ids = { requestId, taskId: fields.taskId.toLowerCase() };

  switch (type as RequestType) {
    case "schedule":
      return parseSchedule(ids, fields.runAt);
    case "cron":
      return parseCron(ids, fields.cron);
    case "cancel":
      return { kind: "request", request: { type: "cancel", ...ids } };
  }
}

type Ids = { requestId: string; taskId: string };

const invalid = (requestId: string | null, code: ErrorCode, detail: string): ParseResult => ({
  kind: "invalid",
  requestId,
  code,
  detail,
});

/** Parses `text` as a JSON object, or returns null. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseSchedule(ids: Ids, rawRunAt: unknown): ParseResult {
  const runAt = typeof rawRunAt === "string" ? parseIsoTime(rawRunAt) : null;
  if (runAt === null) {
    return invalid(
      ids.requestId,
      "invalid_time",
      "runAt must be ISO 8601 with an offset, e.g. 2026-11-01T09:30:00Z",
    );
  }
  return { kind: "request", request: { type: "schedule", ...ids, runAt } };
}

function parseCron(ids: Ids, rawCron: unknown): ParseResult {
  const cronspec = typeof rawCron === "string" ? normalizeCron(rawCron) : null;
  if (cronspec === null) {
    return invalid(
      ids.requestId,
      "invalid_cron",
      "cron must have 5 fields: minute hour day-of-month month day-of-week (no seconds)",
    );
  }
  if (!isValidCron(cronspec)) {
    return invalid(ids.requestId, "invalid_cron", `cron "${cronspec}" is not valid`);
  }
  return { kind: "request", request: { type: "cron", ...ids, cronspec } };
}

/** Collapses whitespace. Returns null unless there are exactly five fields (no seconds field). */
function normalizeCron(raw: string): string | null {
  const fields = raw.trim().split(/\s+/);
  const cronspec = fields.join(" ");
  return fields.length === 5 && cronspec.length <= MAX_CRON_LENGTH ? cronspec : null;
}

/** True if a five-field cron expression parses and has an upcoming run. */
function isValidCron(cronspec: string): boolean {
  try {
    // next() throws for expressions that never match, e.g. "0 0 30 2 *".
    parser.parseExpression(cronspec, { tz: "UTC" }).next();
    return true;
  } catch {
    return false;
  }
}

/** The most recent run of a cron at or before `now`, in epoch milliseconds (UTC). */
export function previousRun(cronspec: string, now: number): number {
  // prev() is strictly before currentDate, so a run exactly at `now` counts.
  return parser
    .parseExpression(cronspec, { tz: "UTC", currentDate: new Date(now + 1) })
    .prev()
    .getTime();
}

/** Checks the window a one-time schedule must fall in. Returns an error, or null if `runAt` is fine. */
export function checkRunAt(runAt: number, now: number): { code: ErrorCode; detail: string } | null {
  if (runAt <= now) return { code: "time_in_past", detail: "runAt must be in the future" };
  if (runAt - now > MAX_SCHEDULE_AHEAD_MS) {
    return { code: "time_too_far", detail: "runAt must be within 366 days" };
  }
  return null;
}

/** Parses a strict ISO 8601 timestamp into epoch milliseconds, or null. */
export function parseIsoTime(value: string): number | null {
  const m = TIME_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Number(m[6] ?? 0);
  const millis = Number((m[7] ?? "0").padEnd(3, "0"));

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  // Date.UTC silently rolls over invalid days (Feb 30 -> Mar 2); reject those.
  if (new Date(local).getUTCDate() !== day) return null;

  let offsetMs = 0;
  if (m[8] !== "Z") {
    const offsetHours = Number(m[10]);
    const offsetMinutes = Number(m[11]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetMs = (m[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  return local - offsetMs;
}

/**
 * Identifies a request by its content, ignoring the request id. A request id
 * that is reused with a different fingerprint is rejected.
 */
export function fingerprint(request: Request): string {
  switch (request.type) {
    case "schedule":
      return JSON.stringify([request.type, request.taskId, request.runAt]);
    case "cron":
      return JSON.stringify([request.type, request.taskId, request.cronspec]);
    case "cancel":
      return JSON.stringify([request.type, request.taskId]);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export function formatAck(request: Request): string {
  const { requestId, type: op, taskId } = request;
  switch (request.type) {
    case "schedule":
      return JSON.stringify({ type: "ack", requestId, op, taskId, runAt: iso(request.runAt) });
    case "cron":
      return JSON.stringify({ type: "ack", requestId, op, taskId, cron: request.cronspec });
    case "cancel":
      return JSON.stringify({ type: "ack", requestId, op, taskId });
  }
}

export const formatError = (requestId: string | null, code: ErrorCode, detail: string) =>
  JSON.stringify({ type: "error", requestId, code, detail });

/**
 * Identifies one notification. The same occurrence of a task always gets the
 * same id, including when it is sent again, so clients can drop duplicates.
 */
export const deliveryId = (taskId: string, scheduledFor: number) =>
  `${taskId}@${iso(scheduledFor)}`;

export const formatDue = (taskId: string, scheduledFor: number) =>
  JSON.stringify({
    type: "due",
    deliveryId: deliveryId(taskId, scheduledFor),
    taskId,
    scheduledFor: iso(scheduledFor),
  });
