import { describe, it, expect, beforeEach } from "vitest";
import {
  noteRawInboundOutcome,
  evaluateInboundStall,
  resetInboundHealthForTests,
} from "../../../src/observability/inboundHealth.js";

const WINDOW_MS = 60 * 60 * 1000; // 1h
const T0 = 1_700_000_000_000;

describe("inboundHealth", () => {
  beforeEach(() => {
    resetInboundHealthForTests();
  });

  it("is not stalled on a fresh process with no traffic", () => {
    expect(evaluateInboundStall(WINDOW_MS, T0).stalled).toBe(false);
  });

  it("is not stalled when inbound is being accepted", () => {
    noteRawInboundOutcome("accepted", "accepted", T0);
    expect(evaluateInboundStall(WINDOW_MS, T0 + 1000).stalled).toBe(false);
  });

  it("flags a stall when the worker contract fails and nothing is accepted", () => {
    // Exactly this incident: every request rejected on signature version.
    noteRawInboundOutcome("rejected", "unsupported_signature_version", T0);
    const status = evaluateInboundStall(WINDOW_MS, T0 + 5 * 60 * 1000);
    expect(status.stalled).toBe(true);
    expect(status.lastContractFailureAtMs).toBe(T0);
  });

  it("treats invalid and replayed signatures as contract failures too", () => {
    noteRawInboundOutcome("rejected", "invalid_signature", T0);
    expect(evaluateInboundStall(WINDOW_MS, T0 + 1000).stalled).toBe(true);
    resetInboundHealthForTests();
    noteRawInboundOutcome("rejected", "replayed_signature", T0);
    expect(evaluateInboundStall(WINDOW_MS, T0 + 1000).stalled).toBe(true);
  });

  it("ignores per-message rejections that a healthy worker can legitimately cause", () => {
    for (const reason of [
      "alias_not_found",
      "sender_not_allowed",
      "rate_limited",
      "missing_signature",
      "empty_body",
      "hosted_blocklist",
    ]) {
      noteRawInboundOutcome("rejected", reason, T0);
    }
    expect(evaluateInboundStall(WINDOW_MS, T0 + 1000).stalled).toBe(false);
  });

  it("clears the stall once a contract failure ages out of the window", () => {
    noteRawInboundOutcome("rejected", "unsupported_signature_version", T0);
    expect(evaluateInboundStall(WINDOW_MS, T0 + WINDOW_MS + 1).stalled).toBe(false);
  });

  it("does not flag a stall when accepts and failures coexist (scanner noise during healthy flow)", () => {
    noteRawInboundOutcome("rejected", "invalid_signature", T0);
    noteRawInboundOutcome("accepted", "accepted", T0 + 1000);
    expect(evaluateInboundStall(WINDOW_MS, T0 + 2000).stalled).toBe(false);
  });

  it("re-flags a stall if accepts stop and failures resume", () => {
    noteRawInboundOutcome("accepted", "accepted", T0);
    // ... an hour passes with no accepts, worker still failing
    noteRawInboundOutcome("rejected", "unsupported_signature_version", T0 + WINDOW_MS + 60_000);
    expect(evaluateInboundStall(WINDOW_MS, T0 + WINDOW_MS + 61_000).stalled).toBe(true);
  });
});
