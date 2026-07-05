# Swordbot OpenClaw Usage 🤖💸

Real-time model-call spend dashboard for OpenClaw. Reads your local
trajectory logs (`~/.openclaw/agents/*/sessions/*.trajectory.jsonl`),
extracts every model call with tokens + cost, and shows you where the
money is going — by model, by agent, by chat channel, by hour.

Built by **Wozbot 🤖** for **Swordbot**.

## Why

The AI spend dashboards that already exist (`swordbot-api-usage`, various
SaaS options) can only see what a provider's billing API tells you.
For Anthropic that needs an Admin API key; for OpenAI a session-class
key; for Google Cloud Billing an OAuth handshake and BigQuery.

But OpenClaw already writes *every model call* to a trajectory JSONL,
including `usage.input`, `usage.output`, and `usage.cost.total` from
the provider's own response. So we can just... read the logs.

- **No API keys needed** — pure filesystem access.
- **Near-realtime** — `fs.watch` + interval scan → <30s from call → chart.
- **Full history** — backfill months of logs in seconds.
- **Attribution** — every call is tagged with the OpenClaw agent, chat
  channel (Slack/WhatsApp/etc), and session id.

## Screens

- **Overview** — headline spend (today / week / month / all-time), stacked
  spend-over-time, provider donut, top models + channels.
- **Models** — full table sortable by cost/calls/tokens.
- **Agents** — per-agent spend + stacked timeline.
- **Channels** — spend attributed to each chat surface.
- **Live** — auto-refreshing tail of the most recent calls.

## Quick start

    npm install
    cp .env.example .env    # tweak PORT / OPENCLAW_ROOT if needed
    npm run build
    npm run backfill        # one-shot rescan of all trajectories
    npm start               # http://localhost:4848

`npm run stats` prints a console summary. `npm run backfill` clears
the DB and rescans everything (useful after pricing table changes).

## How cost is computed

For each assistant message with a `usage` block:

1. If OpenClaw's own `usage.cost.total` is > 0 → use that verbatim (cost_source = "logged").
2. Otherwise, apply the local pricing table in `src/pricing.ts` (cost_source = "estimated").
3. If the model isn't in the pricing table → cost stays 0 (cost_source = "unpriced").

Update `src/pricing.ts` whenever provider prices change. Rerun
`npm run backfill` to recompute historical costs against new prices.

## Data lifecycle

- SQLite at `data/usage.db`. Long-format `model_calls` table + a
  `file_offsets` table so we only read new bytes on rescan.
- Add a new provider? Nothing to do — the scanner works from the raw
  usage shape.
- Add pricing for a model? Edit `src/pricing.ts` + `npm run backfill`.

## Deploy

This is a local-only tool. It reads `~/.openclaw/` so it must run on
the same machine as OpenClaw. Reach it from your phone with Tailscale
or ngrok. Not designed for shared hosting.

## Not (yet)

- No auth — assumed to run on trusted localhost / Tailnet.
- No projections / budget alerts yet (planned).
- Costs for cache-write / cache-read tokens rely on public pricing
  averages when OpenClaw doesn't log them.
