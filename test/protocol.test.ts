import { describe, expect, test } from "bun:test";
import { isScheduleCommand, parseIsoTime, parseScheduleRequest } from "../convex/protocol";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const TASK = "8C7E3F7A-1B2C-4D5E-9F00-112233445566";

describe("isScheduleCommand", () => {
  test("matches plain and addressed commands", () => {
    expect(isScheduleCommand(`/schedule ${TASK} x`, "SchedBot")).toBe(true);
    expect(isScheduleCommand(`/schedule@schedbot ${TASK} x`, "SchedBot")).toBe(true);
  });
  test("ignores other messages", () => {
    expect(isScheduleCommand("/scheduler", "SchedBot")).toBe(false);
    expect(isScheduleCommand("/schedule@OtherBot", "SchedBot")).toBe(false);
    expect(isScheduleCommand("hello", "SchedBot")).toBe(false);
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
