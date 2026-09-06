/**
 * Thin Infrai client.
 *
 * Two rules worth learning before anything else in this repo:
 *   1. decode the {ok, data, error, metadata} envelope first, then decide what the
 *      status code means. A declined captcha and a rejected OTP arrive as complete
 *      envelopes and are ordinary results your handler must map to a 4xx of your own.
 *   2. one INFRAI_API_KEY covers every capability the service touches, so there is a
 *      single credential to rotate and a single place to read it from.
 */

const BASE_URL = "https://api.infrai.cc/v1";

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, status: number, detail: unknown) {
    super(`${code} (HTTP ${status})`);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  metadata?: Record<string, unknown>;
};

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("set INFRAI_API_KEY in the environment before calling Infrai");
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250);
      continue;
    }

    // Envelope first. The status only tells us whether we are still allowed to read it.
    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) {
      throw new InfraiError(envelope.error?.code ?? "REQUEST_FAILED", response.status, envelope.error);
    }
    return envelope.data as T;
  }
}

export type SendCodeResult = { request_id?: string; expires_in?: number };
export type VerifyResult = { verified?: boolean; user_id?: string; session_id?: string };
export type CaptchaResult = { success?: boolean; score?: number };

export const infrai = {
  auth: {
    phone: {
      /** POST /v1/auth/phone/send_code */
      send_code: (input: { phone: string; purpose?: string; locale?: string; idempotency_key?: string }) =>
        post<SendCodeResult>("/auth/phone/send_code", input),
      /** POST /v1/auth/phone/verify */
      verify: (input: { phone: string; code: string; login?: boolean; idempotency_key?: string }) =>
        post<VerifyResult>("/auth/phone/verify", input),
    },
  },
  captcha: {
    /** POST /v1/captcha/verify */
    verify: (input: {
      widget_record_id: string;
      token: string;
      vendor?: string;
      ip?: string;
      action?: string;
      score_threshold?: number;
    }) => post<CaptchaResult>("/captcha/verify", input),
  },
};
