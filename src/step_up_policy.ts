/**
 * The one decision this service exists to make: for a given payment event, is the
 * caller's phone verification still fresh enough, and if not, how hard do we push back?
 *
 * Keeping the rule in a pure function (no network, no clock of its own) is what makes it
 * teachable and testable: the same inputs always produce the same audit line.
 */
import { z } from "zod";

export const PaymentEvent = z.object({
  event_id: z.string().min(1),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164, e.g. +14155552671"),
  kind: z.enum(["card_payment", "payout", "beneficiary_add"]),
  amount_minor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  device_seen_before: z.boolean(),
  /** epoch ms of the last successful phone verification for this user, if any */
  verified_at: z.number().int().nonnegative().nullable(),
  now: z.number().int().positive(),
});
export type PaymentEvent = z.infer<typeof PaymentEvent>;

export type Decision = {
  action: "allow" | "otp" | "captcha_then_otp";
  reason: string;
  /** what an auditor reads six months later */
  audit: { event_id: string; kind: string; amount_minor: number; freshness_ms: number | null };
};

/** A verification counts as fresh for five minutes; large money resets that clock to zero. */
export const FRESHNESS_MS = 5 * 60 * 1000;
/** Above this, a fresh verification is never enough on its own — we always re-ask. */
export const HIGH_VALUE_MINOR = 100_000;

export function decide(raw: unknown): Decision {
  const event = PaymentEvent.parse(raw);
  const freshness = event.verified_at === null ? null : event.now - event.verified_at;
  const audit = {
    event_id: event.event_id,
    kind: event.kind,
    amount_minor: event.amount_minor,
    freshness_ms: freshness,
  };

  if (!event.device_seen_before) {
    return { action: "captcha_then_otp", reason: "first sighting of this device", audit };
  }
  if (event.kind !== "card_payment" || event.amount_minor >= HIGH_VALUE_MINOR) {
    return { action: "otp", reason: "risk-sensitive action always re-verifies", audit };
  }
  if (freshness !== null && freshness < FRESHNESS_MS) {
    return { action: "allow", reason: "phone verification is still fresh", audit };
  }
  return { action: "otp", reason: "verification expired", audit };
}
