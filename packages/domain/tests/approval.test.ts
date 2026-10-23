import { describe, expect, it } from "vitest";
import { actionPayloadHash, backoffDelayMs, type ActionPayload } from "../src/index.js";

const base: ActionPayload = {
  actionType: "SUBMIT_REPAIR_REQUEST",
  incidentId: "i",
  repairRequestId: "r",
  recipientType: "REPAIR_TECHNICIAN",
  recipientAddress: null,
  subject: "s",
  body: "b",
};

describe("action payload hash", () => {
  it("is stable and sensitive to every field", () => {
    expect(actionPayloadHash(base)).toBe(actionPayloadHash({ ...base }));
    for (const k of ["incidentId", "repairRequestId", "recipientType", "subject", "body"] as const)
      expect(actionPayloadHash({ ...base, [k]: "changed" })).not.toBe(actionPayloadHash(base));
    expect(actionPayloadHash({ ...base, recipientAddress: "x@y.z" })).not.toBe(actionPayloadHash(base));
  });
});

describe("backoff", () => {
  it("grows exponentially, is capped, and is jittered within [0, ceiling)", () => {
    expect(backoffDelayMs(1, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelayMs(3, 100, 1000, () => 0.999)).toBe(399);
    expect(backoffDelayMs(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelayMs(2, 100, 1000, () => 0)).toBe(0);
  });
});
