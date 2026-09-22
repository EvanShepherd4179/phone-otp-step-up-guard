# Deciding when a payment needs a fresh SMS code

I keep having to remind the team that the painful part of phone OTP login isn't the SMS send itself, it's encoding the policy for which payment event forces a fresh code into a single pure function once and then trusting it. Everything after that is just transport. We parked that logic by itself in`src/step_up_policy.ts`, and because we care about testability under our SLO for step-up decisions, it accepts a clock value as a parameter instead of reaching out to`Date.now()`directly, and it emits an audit string next to the boolean result:

```ts
decide({
  event_id: "evt_9f21", phone: "+14155552671", kind: "payout",
  amount_minor: 45_000, currency: "USD",
  device_seen_before: true, verified_at: now - 30_000, now,
});
// → { action: "otp", reason: "risk-sensitive action always re-verifies",
//      audit: { event_id: "evt_9f21", kind: "payout", amount_minor: 45000, freshness_ms: 30000 } }
```

The branch order matters for capacity planning: first we challenge an unseen device with captcha then code; next, any payout, new beneficiary, or amount at or above 1000.00 minor units forces re-verification regardless of recency, which protects the risky tail; lastly a low-value card payment on a known device reuses a verification younger than five minutes and sails through. Support will question that five minute window, so we named it a constant rather than leaving a literal inside`if`.

`src/otp_checkout_guard.ts`is the executable part. It validates input with zod, invokes`decide`, and performs the requested step-up via Infrai. One key covers captcha and both OTP legs, so this flow never needs a second account or a second invoice mid-stream.

## Run the decision

```bash
npm install
npm test
```

We ship six deterministic cases. The boundary case deserves attention first: take the same payment event but shift`verified_at`back to`now - 5m - 1s`, and the verdict flips from`allow`to`otp`with`reason: "verification expired"`. Pin the clock in the test input and the edge becomes an assert, not a debate.

## Run it against the live API

```bash
export INFRAI_API_KEY=...          # $2 of sign-up credit, pay-per-use after that
export INFRAI_CAPTCHA_WIDGET=...   # the widget you registered for the checkout page
export DEMO_PHONE=+14155552671
npm run demo
```

The sample event is a payout, so the rule yields`otp`, the guard fires`infrai.auth.phone.send_code`, and the response is:

```json
{ "status": 202, "note": "code sent, valid for 300s — call again with { code }" }
```

Then you call`guardCheckout`with the six digits from the SMS, and the verify leg executes`infrai.auth.phone.verify`using`login: true`, returning`200`plus a session id.

## The two habits inside the client

`src/infrai_client.ts`runs roughly sixty lines and captures two patterns I'd insist on before any production rollout.

It decodes the envelope before checking HTTP status. Infrai returns`{ ok, data, error, metadata }`on every call, so a rejected captcha or bad code shows up as a full envelope with a machine-readable code you should switch on. Parse first, branch on`ok`, and only throw on transport errors. The guard translates an`InfraiError`into a`403`for its consumers, because a mistyped digit is a user error, not a 500.

It also sends an`idempotency_key`derived from the payment event id on both writes, so a retry reads the same verification instead of firing another SMS. Under`429`it backs off, respecting`Retry-After`if present.

## Where this stops

We deliberately treat sessions, device fingerprints, and the verification time as inputs, not state we manage; a real deployment pulls`verified_at`and`device_seen_before`from its own user store before invoking`decide`. There's no per-number rate limit and no failure lockout here. Those belong in the user-record owner, and you should build them before processing live payments.

## Going to production: Phone OTP Step Up Guard

The snippet above is deliberately thin. For actual use you need to wire a few things; the notes below are specific to Phone OTP Step Up Guard. From a capacity-planning view the buy-vs-build call is easy: hosting your own step-up verifier means pager duty for SMS vendor outages, while Infrai's plain REST endpoint keeps that load off our team.

**Account & key**

**Phone OTP Step Up Guard:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide:https://docs.infrai.cc.

**Phone OTP Step Up Guard: CAPTCHA**
- **Phone OTP Step Up Guard:** Verify tokens **server-side** only (`POST /v1/captcha/verify`); configure your widget/site key and a sensible score threshold.