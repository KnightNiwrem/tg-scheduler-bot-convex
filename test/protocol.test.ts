import { describe, expect, test } from "bun:test";
import {
  checkRunAt,
  deliveryId,
  fingerprint,
  formatAck,
  formatDue,
  formatError,
  parseIsoTime,
  parseRequest,
  previousRun,
} from "../convex/protocol";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const TASK = "8C7E3F7A-1B2C-4D5E-9F00-112233445566";
const REQ = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";
const task = TASK.toLowerCase();
const requestId = REQ.toLowerCase();

const msg = (fields: Record<string, unknown>) => JSON.stringify(fields);
const code = (text: string) => {
  const r = parseRequest(text);
  return r.kind === "invalid" ? r.code : r.kind;
};

describe("parseRequest", () => {
  test("parses a schedule request and normalizes ids", () => {
    expect(
      parseRequest(
        msg({ type: "schedule", requestId: REQ, taskId: TASK, runAt: "2026-01-01T08:05:00+08:00" }),
      ),
    ).toEqual({
      kind: "request",
      request: { type: "schedule", requestId, taskId: task, runAt: NOW + 5 * 60_000 },
    });
  });

  test("parses a cron request and normalizes whitespace", () => {
    expect(
      parseRequest(
        msg({ type: "cron", requestId: REQ, taskId: TASK, cron: " */5 9-17  * * MON-FRI" }),
      ),
    ).toEqual({
      kind: "request",
      request: { type: "cron", requestId, taskId: task, cronspec: "*/5 9-17 * * MON-FRI" },
    });
    expect(code(msg({ type: "cron", requestId: REQ, taskId: TASK, cron: "0 0 L * *" }))).toBe(
      "request",
    );
  });

  test("parses a cancel request and ignores unknown fields", () => {
    expect(parseRequest(msg({ type: "cancel", requestId: REQ, taskId: TASK, extra: 1 }))).toEqual({
      kind: "request",
      request: { type: "cancel", requestId, taskId: task },
    });
  });

  test("ignores messages that are not requests", () => {
    for (const text of [
      "hello",
      "/schedule 8c7e3f7a-1b2c-4d5e-9f00-112233445566 2026-01-01T00:05:00Z",
      "{not json",
      "[]",
      "null",
      '"schedule"',
      msg({ requestId: REQ }),
      msg({ type: "Schedule", requestId: REQ, taskId: TASK }),
      // The scheduler's own messages, so two schedulers never answer each other.
      formatAck({ type: "cancel", requestId, taskId: task }),
      formatError(null, "invalid_request_id", "x"),
      formatDue(task, NOW),
    ]) {
      expect(parseRequest(text)).toEqual({ kind: "ignored" });
    }
  });

  test("reports specific errors, with the request id when it is valid", () => {
    expect(parseRequest(msg({ type: "cancel", taskId: TASK }))).toEqual({
      kind: "invalid",
      requestId: null,
      code: "invalid_request_id",
      detail: "requestId must be a UUID",
    });
    expect(code(msg({ type: "cancel", requestId: 1, taskId: TASK }))).toBe("invalid_request_id");
    const invalid = parseRequest(msg({ type: "cancel", requestId: REQ, taskId: "nope" }));
    expect(invalid.kind === "invalid" && invalid.requestId).toBe(requestId);
    expect(invalid.kind === "invalid" && invalid.code).toBe("invalid_task_id");

    const schedule = (runAt: unknown) =>
      code(msg({ type: "schedule", requestId: REQ, taskId: TASK, runAt }));
    expect(schedule(undefined)).toBe("invalid_time");
    expect(schedule("tomorrow")).toBe("invalid_time");
    expect(schedule(NOW + 60_000)).toBe("invalid_time"); // epoch numbers are not accepted
    // Past times parse: they are checked after the duplicate checks (checkRunAt).
    expect(schedule("2020-01-01T00:00:00Z")).toBe("request");

    const cron = (value: unknown) =>
      code(msg({ type: "cron", requestId: REQ, taskId: TASK, cron: value }));
    expect(cron(undefined)).toBe("invalid_cron");
    expect(cron("* * * *")).toBe("invalid_cron");
    expect(cron("*/10 * * * * *")).toBe("invalid_cron"); // six fields: seconds
    expect(cron("@hourly")).toBe("invalid_cron");
    expect(cron("61 * * * *")).toBe("invalid_cron");
    expect(cron("0 0 30 2 *")).toBe("invalid_cron"); // never fires
  });
});

describe("checkRunAt", () => {
  test("accepts the next 366 days only", () => {
    expect(checkRunAt(NOW + 1, NOW)).toBeNull();
    expect(checkRunAt(NOW, NOW)?.code).toBe("time_in_past");
    expect(checkRunAt(Date.parse("2028-01-01T00:00:00Z"), NOW)?.code).toBe("time_too_far");
  });
});

describe("parseIsoTime", () => {
  test("accepts UTC and offsets", () => {
    expect(parseIsoTime("2026-01-01T10:00:00Z")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseIsoTime("2026-01-01T18:00+08:00")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseIsoTime("2026-01-01T05:30:00.5-04:30")).toBe(
      Date.parse("2026-01-01T10:00:00.500Z"),
    );
  });
  test("rejects ambiguous or invalid values", () => {
    for (const value of [
      "2026-01-01T10:00:00", // no offset
      "2026-01-01",
      "2026-02-30T10:00:00Z",
      "2026-13-01T10:00:00Z",
      "2026-01-01T24:00:00Z",
      "1767261600",
    ]) {
      expect(parseIsoTime(value)).toBeNull();
    }
  });
});

describe("fingerprint", () => {
  test("ignores the request id but not the content", () => {
    const a = { type: "schedule", requestId, taskId: task, runAt: NOW } as const;
    expect(fingerprint({ ...a, requestId: crypto.randomUUID() })).toBe(fingerprint(a));
    expect(fingerprint({ ...a, runAt: NOW + 1 })).not.toBe(fingerprint(a));
    expect(fingerprint({ type: "cancel", requestId, taskId: task })).not.toBe(fingerprint(a));
  });
});

describe("previousRun", () => {
  test("is the latest run at or before now", () => {
    const at = (iso: string) => previousRun("*/5 * * * *", Date.parse(iso));
    expect(at("2026-01-01T09:30:00.000Z")).toBe(Date.parse("2026-01-01T09:30:00Z"));
    expect(at("2026-01-01T09:34:59.999Z")).toBe(Date.parse("2026-01-01T09:30:00Z"));
  });
});

describe("formatting", () => {
  test("acks echo the request id and the normalized request", () => {
    expect(
      JSON.parse(formatAck({ type: "schedule", requestId, taskId: task, runAt: NOW })),
    ).toEqual({
      type: "ack",
      requestId,
      op: "schedule",
      taskId: task,
      runAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      JSON.parse(formatAck({ type: "cron", requestId, taskId: task, cronspec: "0 9 * * *" })),
    ).toEqual({
      type: "ack",
      requestId,
      op: "cron",
      taskId: task,
      cron: "0 9 * * *",
    });
  });

  test("due notifications have a delivery id that is stable per run", () => {
    expect(JSON.parse(formatDue(task, NOW))).toEqual({
      type: "due",
      deliveryId: `${task}@2026-01-01T00:00:00.000Z`,
      taskId: task,
      scheduledFor: "2026-01-01T00:00:00.000Z",
    });
    expect(deliveryId(task, NOW)).toBe(deliveryId(task, NOW));
    expect(deliveryId(task, NOW + 60_000)).not.toBe(deliveryId(task, NOW));
  });
});
