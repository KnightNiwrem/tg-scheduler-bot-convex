// Wire protocol between client bots and the scheduler bot. Pure functions only,
// so this module can be unit tested outside of Convex.
//
//   request:      /schedule <task-uuid> <run-at>
//   ack:          scheduled <task-uuid> <run-at as ISO 8601 UTC>
//   request:      /cron <task-uuid> <minute> <hour> <day-of-month> <month> <day-of-week>
//   ack:          cron <task-uuid> <cron expression>
//   request:      /cancel <task-uuid>
//   ack:          cancelled <task-uuid>
//   error:        error <code> <human readable detail>
//   notification: /due <task-uuid>

import parser from "cron-parser";

export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_CRON_LENGTH = 100;

export type Command = "schedule" | "cron" | "cancel";
const COMMANDS: readonly Command[] = ["schedule", "cron", "cancel"];

export type ErrorCode =
  | "invalid_request"
  | "invalid_task_id"
  | "invalid_time"
  | "time_in_past"
  | "time_too_far"
  | "invalid_cron"
  | "conflict"
  | "not_found"
  | "quota_exceeded"
  | "internal";

type ParseError = { ok: false; code: ErrorCode; detail: string };
export type ParseResult = { ok: true; taskId: string; runAt: number } | ParseError;
export type CronParseResult = { ok: true; taskId: string; cronspec: string } | ParseError;
export type CancelParseResult = { ok: true; taskId: string } | ParseError;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ISO 8601 date-time with a mandatory UTC offset, e.g. 2026-11-01T09:30:00Z
// or 2026-11-01T17:30:00+08:00. Seconds and milliseconds are optional.
const TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Returns the command `text` is addressed to, optionally in the
 * `/schedule@SchedulerBot` form, or null. Messages without a command are
 * ignored by the bot.
 */
export function parseCommand(text: string, botUsername: string): Command | null {
  const head = text.trimStart().split(/\s/, 1)[0] ?? "";
  for (const command of COMMANDS) {
    if (
      head === `/${command}` ||
      head.toLowerCase() === `/${command}@${botUsername.toLowerCase()}`
    ) {
      return command;
    }
  }
  return null;
}

export function parseScheduleRequest(text: string, now: number): ParseResult {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 3) {
    return {
      ok: false,
      code: "invalid_request",
      detail: "expected: /schedule <task-uuid> <ISO-8601 time with offset>",
    };
  }
  const [, rawTaskId, rawTime] = parts as [string, string, string];

  if (!UUID_RE.test(rawTaskId)) {
    return { ok: false, code: "invalid_task_id", detail: "task id must be a UUID" };
  }

  const runAt = parseIsoTime(rawTime);
  if (runAt === null) {
    return {
      ok: false,
      code: "invalid_time",
      detail: "time must be ISO 8601 with an offset, e.g. 2026-11-01T09:30:00Z",
    };
  }
  if (runAt <= now) {
    return { ok: false, code: "time_in_past", detail: "time must be in the future" };
  }
  if (runAt - now > MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, code: "time_too_far", detail: "time must be within 366 days" };
  }

  return { ok: true, taskId: rawTaskId.toLowerCase(), runAt };
}

/**
 * Parses a recurring request. The cron expression must have exactly five
 * fields (minute to day of week, evaluated in UTC). A seconds field is not
 * accepted, so a schedule never fires more than once a minute.
 */
export function parseCronRequest(text: string): CronParseResult {
  const [, rawTaskId, ...fields] = text.trim().split(/\s+/);
  if (rawTaskId === undefined || fields.length === 0) {
    return {
      ok: false,
      code: "invalid_request",
      detail: "expected: /cron <task-uuid> <minute> <hour> <day-of-month> <month> <day-of-week>",
    };
  }
  if (!UUID_RE.test(rawTaskId)) {
    return { ok: false, code: "invalid_task_id", detail: "task id must be a UUID" };
  }

  const cronspec = fields.join(" ");
  if (fields.length !== 5 || cronspec.length > MAX_CRON_LENGTH) {
    return {
      ok: false,
      code: "invalid_cron",
      detail: "cron must have 5 fields: minute hour day-of-month month day-of-week (no seconds)",
    };
  }
  if (!isValidCron(cronspec)) {
    return { ok: false, code: "invalid_cron", detail: `cron "${cronspec}" is not valid` };
  }

  return { ok: true, taskId: rawTaskId.toLowerCase(), cronspec };
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

export function parseCancelRequest(text: string): CancelParseResult {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) {
    return { ok: false, code: "invalid_request", detail: "expected: /cancel <task-uuid>" };
  }
  const rawTaskId = parts[1]!;
  if (!UUID_RE.test(rawTaskId)) {
    return { ok: false, code: "invalid_task_id", detail: "task id must be a UUID" };
  }
  return { ok: true, taskId: rawTaskId.toLowerCase() };
}

/** Parses a strict ISO 8601 timestamp into epoch milliseconds, or null. */
export function parseIsoTime(value: string): number | null {
  const m = TIME_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [
    number, number, number, number, number,
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

export const formatAck = (taskId: string, runAt: number) =>
  `scheduled ${taskId} ${new Date(runAt).toISOString()}`;

export const formatCronAck = (taskId: string, cronspec: string) => `cron ${taskId} ${cronspec}`;

export const formatCancelled = (taskId: string) => `cancelled ${taskId}`;

export const formatError = (code: ErrorCode, detail: string) => `error ${code} ${detail}`;

export const formatDue = (taskId: string) => `/due ${taskId}`;
