import { describe, expect, test } from "bun:test";
import {
  parseCancelRequest,
  parseCommand,
  parseCronRequest,
  parseIsoTime,
  parseScheduleRequest,
} from "../convex/protocol";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const TASK = "8C7E3F7A-1B2C-4D5E-9F00-112233445566";

describe("parseCommand", () => {
  test("matches plain and addressed commands", () => {
    expect(parseCommand(`/schedule ${TASK} x`, "SchedBot")).toBe("schedule");
    expect(parseCommand(`/schedule@schedbot ${TASK} x`, "SchedBot")).toBe("schedule");
    expect(parseCommand(`/cron ${TASK} * * * * *`, "SchedBot")).toBe("cron");
    expect(parseCommand(`/cancel@SchedBot ${TASK}`, "SchedBot")).toBe("cancel");
  });
  test("ignores other messages", () => {
    expect(parseCommand("/scheduler", "SchedBot")).toBeNull();
    expect(parseCommand("/schedule@OtherBot", "SchedBot")).toBeNull();
    expect(parseCommand("/crontab", "SchedBot")).toBeNull();
    expect(parseCommand("/due x", "SchedBot")).toBeNull();
    expect(parseCommand("hello", "SchedBot")).toBeNull();
  });
});

describe("parseIsoTime", () => {
  test("accepts UTC and offsets", () => {
    expect(parseIsoTime("2026-01-01T10:00:00Z")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseIsoTime("2026-01-01T18:00+08:00")).toBe(Date.parse("2026-01-01T10:00:00Z"));
    expect(parseIsoTime("2026-01-01T05:30:00.5-04:30")).toBe(Date.parse("2026-01-01T10:00:00.500Z"));
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

describe("parseScheduleRequest", () => {
  test("parses a valid request and normalizes the task id", () => {
    expect(parseScheduleRequest(`/schedule ${TASK} 2026-01-01T00:05:00Z`, NOW)).toEqual({
      ok: true,
      taskId: TASK.toLowerCase(),
      runAt: NOW + 5 * 60_000,
    });
  });
  test("reports specific errors", () => {
    const code = (text: string) => {
      const r = parseScheduleRequest(text, NOW);
      return r.ok ? "ok" : r.code;
    };
    expect(code("/schedule")).toBe("invalid_request");
    expect(code(`/schedule ${TASK} 2026-01-01T00:05:00Z extra`)).toBe("invalid_request");
    expect(code("/schedule not-a-uuid 2026-01-01T00:05:00Z")).toBe("invalid_task_id");
    expect(code(`/schedule ${TASK} tomorrow`)).toBe("invalid_time");
    expect(code(`/schedule ${TASK} 2025-12-31T23:59:59Z`)).toBe("time_in_past");
    expect(code(`/schedule ${TASK} 2028-01-01T00:00:00Z`)).toBe("time_too_far");
  });
});

describe("parseCronRequest", () => {
  test("parses a valid request and normalizes whitespace and the task id", () => {
    expect(parseCronRequest(`/cron ${TASK}  */5 9-17  * * MON-FRI`)).toEqual({
      ok: true,
      taskId: TASK.toLowerCase(),
      cronspec: "*/5 9-17 * * MON-FRI",
    });
    expect(parseCronRequest(`/cron ${TASK} 0 0 L * *`).ok).toBe(true);
  });
  test("reports specific errors", () => {
    const code = (text: string) => {
      const r = parseCronRequest(text);
      return r.ok ? "ok" : r.code;
    };
    expect(code("/cron")).toBe("invalid_request");
    expect(code(`/cron ${TASK}`)).toBe("invalid_request");
    expect(code("/cron not-a-uuid * * * * *")).toBe("invalid_task_id");
    expect(code(`/cron ${TASK} * * * *`)).toBe("invalid_cron");
    expect(code(`/cron ${TASK} @hourly`)).toBe("invalid_cron");
    expect(code(`/cron ${TASK} 61 * * * *`)).toBe("invalid_cron");
    expect(code(`/cron ${TASK} 0 0 30 2 *`)).toBe("invalid_cron"); // never fires
  });
  test("rejects schedules more frequent than once a minute", () => {
    const r = parseCronRequest(`/cron ${TASK} */10 * * * * *`); // six fields: seconds
    expect(r.ok ? "ok" : r.code).toBe("invalid_cron");
  });
});

describe("parseCancelRequest", () => {
  test("parses a valid request", () => {
    expect(parseCancelRequest(`/cancel ${TASK}`)).toEqual({ ok: true, taskId: TASK.toLowerCase() });
  });
  test("reports specific errors", () => {
    const code = (text: string) => {
      const r = parseCancelRequest(text);
      return r.ok ? "ok" : r.code;
    };
    expect(code("/cancel")).toBe("invalid_request");
    expect(code(`/cancel ${TASK} extra`)).toBe("invalid_request");
    expect(code("/cancel nope")).toBe("invalid_task_id");
  });
});
