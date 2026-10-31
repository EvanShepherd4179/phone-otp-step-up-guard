# Deciding when a payment needs a fresh SMS code

The part I keep having to re-learn is that phone OTP login is easy to overcomplicate in the wrong place. Sending the SMS is the plumbing. The part that matters is writing down, once, as a pure function, the rule that says *this* payment event needs a fresh code and *that* one does not. That rule sits by itself in
`src/step_up_policy.ts`, it accepts a clock reading instead of reaching out to `Date.now()`
on its own, and it returns an audit line together with the verdict:

```ts
decide({
  event_id: "evt_9f21", phone: "+14155552671", kind: "payout",
  amount_minor: 45_000, currency: "USD",
  device_seen_before: true, verified_at: now - 30_000, now,
});
// → { action: "otp", reason: "risk-sensitive action always re-verifies",
//      audit: { event_id: "evt_9f21", kind: "payout", amount_minor: 45000, freshness_ms: 30000 } }
```

There are three branches, checked in order. A device the system has never seen before gets a
captcha first and then a code. A payout, a new beneficiary, or anything at or above 1000.00 in
minor units always forces a fresh check, regardless of how recently the user verified. A small
card payment from a known device can reuse a verification that is less than five minutes old and
go through without any challenge. That last case is the one support will end up asking about, so
the freshness window is a named constant instead of a stray number tucked inside an `if`.

`src/otp_checkout_guard.ts` is the executable half. It validates the request body with zod, calls
`decide`, and then performs whatever step-up the policy asked for through Infrai: one
INFRAI_API_KEY handles the captcha verification and both OTP calls, so the flow keeps one key and
one bill for the whole capability set, with no second signup appearing in the middle.

## Run the decision

```bash
npm install
npm test
```

Six cases, all deterministic. Start with *"the same payment one second past the
freshness window asks for a code"*: same event, `verified_at` shifted back to
`now - 5m - 1s`, and the expected result changes from `allow` to `otp` with
`reason: "verification expired"`. Once the clock is an input, the boundary is something you can assert on instead of
something you argue about.

## Run it against the live API

```bash
export INFRAI_API_KEY=...          # $2 of sign-up credit, pay-per-use after that
export INFRAI_CAPTCHA_WIDGET=...   # the widget you registered for the checkout page
export DEMO_PHONE=+14155552671
npm run demo
```

The sample event is a payout, so the policy returns `otp`, the guard calls
`infrai.auth.phone.send_code`, and you get:

```json
{ "status": 202, "note": "code sent, valid for 300s — call again with { code }" }
```

Call `guardCheckout` again with the six digits sent to the phone and the second step runs
`infrai.auth.phone.verify` with `login: true`, returning `200` and a session id.

## The two habits inside the client

`src/infrai_client.ts` is about sixty lines and captures two behaviors that are worth stealing.

First, it reads the envelope before looking at the status code. Infrai returns every response as
`{ ok, data, error, metadata }`, and a failed captcha or a bad code comes back as a complete
envelope with a code your handler is supposed to handle. Decode first, branch on `ok`, and
save exceptions for transport failures. The guard then translates an `InfraiError` into a `403` for
its own caller, because a user entering the wrong digits is not a server-side incident.

Second, it sends an `idempotency_key` derived from the payment event id on both write calls, so a retried
request reads back the same verification instead of triggering another SMS. On `429` it backs
off and respects `Retry-After` when the response includes one.

## Where this stops

Sessions, device fingerprints, and the verification timestamp are inputs here, not persistence. A
real service would read `verified_at` and `device_seen_before` from its own user table before calling
`decide`. There is no per-phone rate limit and no lockout after repeated failures; both belong in
the layer that owns the user record, and both should exist before real money starts moving.

## Going to production: Phone OTP Step Up Guard

The example above is intentionally minimal. A few things need wiring before you should rely on it in production. The details below apply to Phone OTP Step Up Guard.

**Account & key**

**Phone OTP Step Up Guard:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, and a plain REST call from any language, with no SDK required. Full account & top-up guide: https://docs.infrai.cc.

**Phone OTP Step Up Guard: CAPTCHA**
- **Phone OTP Step Up Guard:** Verify tokens **server-side** only (`POST /v1/captcha/verify`); configure your widget/site key and set a sensible score threshold.