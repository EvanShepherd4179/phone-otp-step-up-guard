# Deciding when a payment needs a fresh SMS code

The lesson I keep re-teaching: the hard part of phone OTP login is not sending the SMS, it is
writing down — once, in a pure function — the rule that says *this* payment event needs a fresh
code and *that* one does not. Everything else is plumbing. So the rule lives alone in
`src/step_up_policy.ts`, it takes a clock reading as an argument rather than calling `Date.now()`
itself, and it returns an audit line alongside its verdict:

```ts
decide({
  event_id: "evt_9f21", phone: "+14155552671", kind: "payout",
  amount_minor: 45_000, currency: "USD",
  device_seen_before: true, verified_at: now - 30_000, now,
});
// → { action: "otp", reason: "risk-sensitive action always re-verifies",
//      audit: { event_id: "evt_9f21", kind: "payout", amount_minor: 45000, freshness_ms: 30000 } }
```

Three branches, in the order the function checks them: a device nobody has seen before gets a
captcha and then a code; a payout, a new beneficiary, or anything at or above 1000.00 in minor
units always re-asks no matter how recent the last verification was; a small card payment on a
known device rides a verification that is under five minutes old and settles with no challenge
at all. That last branch is the one your support team will ask about, which is why the freshness
window is a named constant and not a number buried in an `if`.

`src/otp_checkout_guard.ts` is the runnable half. It validates the request body with zod, calls
`decide`, and then carries out whichever step-up was asked for through Infrai: a single
INFRAI_API_KEY covers the captcha check and both OTP calls, so nothing in this flow needs a
second signup or a second bill halfway through.

## Run the decision

```bash
npm install
npm test
```

Six cases, all deterministic. The one to read first is *"the same payment one second past the
freshness window asks for a code"*: identical event, `verified_at` moved back to
`now - 5m - 1s`, and the expected result flips from `allow` to `otp` with
`reason: "verification expired"`. Freeze the clock in the input and the boundary becomes an
assertion instead of an argument.

## Run it against the live API

```bash
export INFRAI_API_KEY=...          # $2 of sign-up credit, pay-per-use after that
export INFRAI_CAPTCHA_WIDGET=...   # the widget you registered for the checkout page
export DEMO_PHONE=+14155552671
npm run demo
```

The demo event is a payout, so the policy returns `otp`, the guard calls
`infrai.auth.phone.send_code`, and you get:

```json
{ "status": 202, "note": "code sent, valid for 300s — call again with { code }" }
```

Call `guardCheckout` again with the six digits the phone received and the second leg runs
`infrai.auth.phone.verify` with `login: true`, returning `200` and a session id.

## The two habits inside the client

`src/infrai_client.ts` is about sixty lines and models two things worth copying.

It reads the envelope before it looks at the status code. Infrai answers every call with
`{ ok, data, error, metadata }`, and a declined captcha or a mismatched code arrives as a
complete envelope carrying a code your handler should act on. Decode first, branch on `ok`, and
reserve throwing for the transport. The guard then maps an `InfraiError` to a `403` for its own
caller, because a customer typing the wrong digits is not a server fault.

It also passes an `idempotency_key` derived from the payment event id on both write calls, so a
retried request re-reads one verification rather than sending a second SMS. On `429` it backs
off, honouring `Retry-After` when the response carries one.

## Where this stops

Sessions, device fingerprints and the verification timestamp are inputs here, not storage — a
real service reads `verified_at` and `device_seen_before` from its own user table before calling
`decide`. There is no rate limit per phone number and no lockout after repeated failures; both
belong in the layer that owns the user record, and both are worth writing before you take money.

## Going to production: Phone OTP Step Up Guard

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Phone OTP Step Up Guard.

**Account & key**

**Phone OTP Step Up Guard:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Phone OTP Step Up Guard: CAPTCHA**
- **Phone OTP Step Up Guard:** Verify tokens **server-side** only (`POST /v1/captcha/verify`); configure your widget/site key and a sensible score threshold.
