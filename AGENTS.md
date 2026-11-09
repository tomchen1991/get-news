# get-news
Cloudflare Workers + D1, TypeScript. Source adapters normalize untrusted news; LLM is only a judge, never a tool executor.

- Run `npm ci`, `npm run check`, and `npm run build` before delivery.
- Tests must mock external feeds, model APIs and webhooks. Never invoke real model calls or sends unless specifically authorized.
- Never commit credentials or `.dev.vars`. Do not deploy without approval.
- Keep source collection independent of judging and notification transports.
- Invalid judgments fail closed; do not fabricate a decision on errors.
- Every outbound alert is reserved in D1 first. Ambiguous webhook outcomes must not be retried automatically.
- Preserve input limits, HTTP security checks, UTC Cron/local-user-time distinction and per-user notification limits.
