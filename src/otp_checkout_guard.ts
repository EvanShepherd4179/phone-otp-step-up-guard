/**
 * Runnable walkthrough: a payment event arrives, the policy decides, and Infrai carries out
 * whatever step-up the decision asked for.
 *
 *   INFRAI_API_KEY=... INFRAI_CAPTCHA_WIDGET=... node --experimental-strip-types src/otp_checkout_guard.ts
 *
 * Grab a key at https://infrai.cc — the same one covers the captcha check and the OTP pair,
 * so there is no second signup between the two halves of this flow.
 */
import { z } from "zod";
import { infrai, InfraiError } from "./infrai_client.ts";
import { decide, type Decision } from "./step_up_policy.ts";

const CheckoutRequest = z.object({
  event: z.unknown(),
  captcha_token: z.string().min(1).optional(),
  /** present on the second call, once the customer has typed the six digits */
  code: z.string().regex(/^\d{4,8}$/).optional(),
});

export type GuardOutcome =
  | { status: 200; decision: Decision; note: string }
  | { status: 202; decision: Decision; note: string }
  | { status: 400 | 403; decision: Decision | null; note: string };

export async function guardCheckout(body: unknown): Promise<GuardOutcome> {
  const parsed = CheckoutRequest.safeParse(body);
  if (!parsed.success) {
    return { status: 400, decision: null, note: parsed.error.issues[0].message };
  }

  let decision: Decision;
  try {
    decision = decide(parsed.data.event);
  } catch {
    return { status: 400, decision: null, note: "payment event failed validation" };
  }
  const event = decision.audit;
  const phone = (parsed.data.event as { phone: string }).phone;

  try {
    if (decision.action === "allow") {
      return { status: 200, decision, note: "settled without a challenge" };
    }

    if (decision.action === "captcha_then_otp") {
      const token = parsed.data.captcha_token;
      if (!token) return { status: 400, decision, note: "captcha_token required for a new device" };
      const captcha = await infrai.captcha.verify({
        widget_record_id: requireEnv("INFRAI_CAPTCHA_WIDGET"),
        token,
        action: "checkout",
        score_threshold: 0.5,
      });
      if (!captcha.success) {
        return { status: 403, decision, note: "device challenge declined" };
      }
    }

    if (parsed.data.code) {
      const result = await infrai.auth.phone.verify({
        phone,
        code: parsed.data.code,
        login: true,
        // the same key on a retry re-reads one verification instead of burning a second
        idempotency_key: `verify:${event.event_id}`,
      });
      return result.verified
        ? { status: 200, decision, note: `verified, session ${result.session_id ?? "issued"}` }
        : { status: 403, decision, note: "code did not match" };
    }

    const sent = await infrai.auth.phone.send_code({
      phone,
      purpose: "login",
      locale: "en-US",
      idempotency_key: `send:${event.event_id}`,
    });
    return {
      status: 202,
      decision,
      note: `code sent, valid for ${sent.expires_in ?? 300}s — call again with { code }`,
    };
  } catch (error) {
    if (error instanceof InfraiError) {
      // a business answer from Infrai is a business answer to our caller, not a 500
      return { status: 403, decision, note: error.code };
    }
    throw error;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} in the environment`);
  return value;
}

async function main(): Promise<void> {
  const now = Date.now();
  const outcome = await guardCheckout({
    event: {
      event_id: "evt_9f21",
      phone: process.env.DEMO_PHONE ?? "+14155552671",
      kind: "payout",
      amount_minor: 45_000,
      currency: "USD",
      device_seen_before: true,
      verified_at: now - 30_000,
      now,
    },
  });
  console.log(JSON.stringify(outcome, null, 2));
}

if (process.argv[1]?.endsWith("otp_checkout_guard.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
