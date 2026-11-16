import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, migrate, type Event } from "../src/repository";

const at = (v: number, seq: number, id = "d1"): Event<{ text: string }> =>
  ({ schemaVersion: v, seq, id, ts: "2026-01-01T00:00:00.000Z", text: `v${v}` });

describe("migrate", () => {
  it("skips and counts events with an unknown future schema version", () => {
    const result = migrate([at(2, 1)]);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts an older event when no step is registered", () => {
    const result = migrate([at(0, 1)]);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts a step that does not increase the version", () => {
    const steps = { 0: (event: Event<unknown>): Event<unknown> => ({ ...event, schemaVersion: 0 }) };
    const result = migrate([at(0, 1)], steps);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts a step that returns null", () => {
    const steps = { 0: (): Event<unknown> | null => null };
    const result = migrate([at(0, 1)], steps);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("does not mutate the input array or the input events", () => {
    const input = [at(0, 1)];
    const snapshot = input.map((e) => ({ ...e }));
    const steps = { 0: (event: Event<unknown>): Event<unknown> => ({ ...event, schemaVersion: 1 }) };
    const result = migrate(input, steps);
    expect(input).toEqual(snapshot);
    expect(input[0] === result.events[0]).toBe(false);
    expect(migrate(input).skipped).toBe(1);
  });

  it("passes through events already at the current schema version", () => {
    const events = [at(1, 1)];
    const result = migrate(events);
    expect(result.skipped).toBe(0);
    expect(result.events).toEqual(events);
  });

  it("migrates an older event with a registered step and is idempotent", () => {
    const step = (event: Event<unknown>): Event<unknown> => ({
      ...event,
      schemaVersion: SCHEMA_VERSION,
    });
    const result = migrate([at(0, 1)], { 0: step });
    expect(result.events.map((e) => e.schemaVersion)).toEqual([1]);
    expect(result.skipped).toBe(0);
    const again = migrate(result.events);
    expect(again.events).toEqual(result.events);
    expect(again.skipped).toBe(0);
  });
});
