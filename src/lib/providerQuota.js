// ── "The AI provider has no credit left" ─────────────────────────────────────────────────────────
//
// OpenAI returns `insufficient_quota` as **HTTP 429**, the same status it uses for a rate limit.
// That single fact caused two separate wrongs on 2026-09-22, when the account balance reached $0:
//
//   1. THE RETRY LOOPS TREATED IT AS A RATE LIMIT. Every vision call backs off and retries a 429 up
//      to six times, honouring the "try again in Xs" hint — which is exactly right for a TPM cap and
//      exactly wrong here. An empty balance does not refill in six seconds, so the request sat
//      through the whole backoff and failed anyway, slowly.
//   2. THE FAILURE REACHED AN ADMIN AS "Internal server error" and paged Sentry as though the code
//      had broken. It had not. An account out of credit is an expected, recoverable operating
//      condition with an obvious remedy, and it should read like one.
//
// ⚠️ A RATE LIMIT AND AN EMPTY BALANCE ARE OPPOSITE INSTRUCTIONS. One says "the same request will
// work shortly, wait"; the other says "no request will work until somebody pays". Retrying the
// second wastes the caller's time and hides the only thing they needed to be told.

/** Thrown instead of a bare Error when the provider says the account has no credit. */
export class ProviderQuotaError extends Error {
  constructor(provider = 'OpenAI') {
    super(`${provider} has no credit left — top up the account to generate again.`);
    this.name = 'ProviderQuotaError';
    this.code = 'PROVIDER_NO_CREDIT';
    /* 503, not 500: the service is temporarily unable, and nothing about the request was wrong.
       Not 402 either — that is OUR credits, which a baker tops up in Billing; this is our own
       provider account and only we can fix it. Keeping them apart matters because the two produce
       completely different advice on screen. */
    this.status = 503;
    /* Read by the error responder: this is an operating condition, not a defect, so it must not be
       reported as an exception. A Sentry alert every time the balance runs out trains people to
       ignore Sentry. */
    this.expected = true;
  }
}

/**
 * Is this 429 an empty balance rather than a rate limit?
 *
 * Matched on the BODY, because the status cannot tell them apart. `insufficient_quota` is the code
 * OpenAI returns for an exhausted balance; `billing_hard_limit_reached` for an account that has hit
 * a configured cap. Both mean the same thing to a caller: waiting will not help.
 */
export function isQuotaExhausted(bodyText) {
  return /insufficient_quota|billing_hard_limit_reached|exceeded your current quota/i.test(String(bodyText ?? ''));
}
