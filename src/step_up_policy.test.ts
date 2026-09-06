import test from "node:test";
import assert from "node:assert/strict";
import { decide, FRESHNESS_MS, HIGH_VALUE_MINOR } from "./step_up_policy.ts";

const NOW = 1_760_000_000_000;
const base = {
  event_id: "evt_1",
  phone: "+14155552671",
  kind: "card_payment" as const,
  amount_minor: 2_500,
  currency: "USD",
  device_seen_before: true,
  verified_at: NOW - 30_000,
  now: NOW,
};

test("a small card payment on a known device rides a fresh verification", () => {
  const d = decide(base);
  assert.equal(d.action, "allow");
  assert.equal(d.audit.freshness_ms, 30_000);
});

test("the same payment one second past the freshness window asks for a code", () => {
  const d = decide({ ...base, verified_at: NOW - FRESHNESS_MS - 1_000 });
  assert.equal(d.action, "otp");
  assert.equal(d.reason, "verification expired");
});

test("high value re-verifies even when the last code was seconds old", () => {
  const d = decide({ ...base, amount_minor: HIGH_VALUE_MINOR });
  assert.equal(d.action, "otp");
});

test("a payout is risk-sensitive regardless of amount", () => {
  assert.equal(decide({ ...base, kind: "payout", amount_minor: 100 }).action, "otp");
});

test("an unknown device gets the captcha before the code", () => {
  assert.equal(decide({ ...base, device_seen_before: false }).action, "captcha_then_otp");
});

test("a phone that is not E.164 never reaches the policy", () => {
  assert.throws(() => decide({ ...base, phone: "415-555-2671" }));
});
