# flaww

Social listening for one person. It watches a handful of subreddits, Threads
keywords, and (optionally) X tags, screens what it finds with a cheap model,
and pings you on Telegram when something is worth answering. You reply to the
ping with your own words, and those words get posted — verbatim — on the
thread they were written for.

Nothing rewrites you. Nothing posts without you. The only thing being
automated today is *finding the post and getting it in front of you*.

```
  reddit   r/x r/y …   ─┐
  threads  "kw" "kw"   ─┤
  x        #tag #tag   ─┼─▶ prefilter ─▶ screen ─▶ Telegram ping
  linkedin own posts   ─┘   (free)      (nano)          │
       ▲                                                 │  you type a reply
       │                                                 ▼
  each independently                          governor ─▶ posted, verbatim
  toggleable                                  (when, not what)
                                                         │
                                                         ▼
                                                  style corpus
                                             (every reply you write)
```

---

## Why the corpus matters more than anything else here

The pipeline above is maybe a week of work for anyone who wants to copy it.
What isn't copyable is a few hundred examples of **how you specifically answer
a specific kind of post**. That's what makes the later automation possible, and
it's why `Reply.text` stores your text byte-for-byte with no normalisation, no
cleaning, and no rewriting.

Every reply you send is one labelled example. Every card you `/skip` is a
labelled negative. Both are captured from day one, before anything reads them.
`npm run corpus:stats` tracks it; ~150 published replies is where drafting in
your voice starts to work.

---

## Sources

Each has its own `enabled` flag in `flaww.config.ts`. Turning one off disables
it completely — polling, reading, screening, publishing, everything. Nothing
else needs to change.

| | Cost | What it can see | Ships |
|---|---|---|---|
| **Reddit** | free | any post in your listed subreddits | **on** |
| **Threads** | free | any post matching your keywords | **on** |
| **X** | **per tweet read** | any post matching your tags | off |
| **LinkedIn** | free | **only comments on your own posts** | off |

**Reddit and Threads are the free listening surfaces**, which is why both ship
enabled — you can run flaww indefinitely at $0 of platform cost.

**X is the only source that bills per item.** Reads are $0.005/tweet and
replies $0.015 (**$0.20 if the reply contains a link** — a 13× penalty flaww
warns you about before you spend it). Budgets for X are therefore denominated
in *tweets*, not requests: one request can return 100 tweets, so counting
requests would understate your bill by up to 100×.

**LinkedIn is not like the other three.** It has no public post-search API —
there is no legitimate way to discover strangers' posts by keyword, and
anything that claims otherwise is scraping. What flaww does instead is watch
new comments on *your own* posts, which is genuinely useful but is a different
job from keyword monitoring. It also needs Community Management API approval
(manual review, often weeks). Hence: off by default.

---

## Setup

```bash
cd flaww
npm install
cp .env.example .env      # fill it in
npx prisma generate
npm run db:push
```

You need a **Postgres** database. [Neon](https://neon.tech)'s free tier is more
than enough for this volume; Cloud SQL works identically if you'd rather keep
everything in GCP. Append `?sslmode=require&pgbouncer=true&connection_limit=1`
to the URL — Cloud Run instances are short-lived and a full pool per instance
will exhaust the database's connection limit.

Then edit **`flaww.config.ts`** — the one file you'll actually touch.

```bash
npm run doctor
```

Doctor is worth running before anything else. One live call per subsystem; it
tells you specifically if the model ID is wrong, if the bot can't reach your
chat, if a poll interval would blow a budget, and what X will cost you at the
current settings.

### First day: dry run

```bash
DRY_RUN=1 npm start
```

Screens, pings, and accepts your replies, but posts nothing. Watch what comes
through for a day and tune `screening.minConfidence` and
`persona.negativeTerms` before letting it publish.

---

## Deploying to Cloud Run

```bash
export GCP_PROJECT=your-project
export GCP_REGION=europe-west1
npm run deploy
```

`deploy/deploy.sh` is idempotent. It pushes secrets to Secret Manager, deploys
the service, and creates three Cloud Scheduler jobs.

### What changes on serverless, and why

Cloud Run scale-to-zero breaks two assumptions that a long-running process
gets for free. Both are handled, and the result is actually better:

**Telegram uses webhooks, not long polling.** There's no process sitting around
to hold a poll open. Every message arrives as an HTTP request that wakes the
container. flaww registers its own webhook on boot, so redeploying to a new URL
self-heals.

**Cloud Scheduler drives the cycles, not an in-process timer.** This is the
important one: **CPU is only guaranteed while a request is in flight.** You
cannot ack a webhook and finish the work in the background — the instance can
be frozen the moment you respond. So every handler completes its work before
replying, and the poll/publish cycles are HTTP endpoints:

| Job | Cadence | What it does |
|---|---|---|
| `flaww-poll` | every 5 min | a *tick* — each source still waits out its own `pollMinutes`, so this just decides who's due |
| `flaww-publish` | every 2 min | publishes anything past its scheduled time; bounds how late a reply can fire |
| `flaww-housekeeping` | daily 04:17 | prunes budget windows, purges raw payloads >30d, clears expired locks |

Putting the cadence outside the container has a real safety benefit: a crash
loop can't turn into a poll storm, and you can change the schedule without a
redeploy.

**`--max-instances=1` is load-bearing, not a cost tweak.** flaww holds
per-source poll cursors and publishes at-most-once; one instance makes both
trivially correct. `src/lock.ts` is a Postgres-backed mutex covering the gap
during a revision rollover, when Cloud Run briefly runs old and new together —
without it, two overlapping poll cycles read every source twice, which on X
means being billed twice.

**Cost:** at this volume Cloud Run stays inside the free tier (2M requests,
360k GB-s/month) — roughly 20k invocations/month of a couple of seconds each.
Cloud Scheduler's free tier is 3 jobs, which is exactly what this uses.

---

## Using it

A card arrives:

```
🟠 some_user · r/devops · 23m ago · 87%

Our SOC 2 Type II audit is a nightmare. Auditor wants 47 separate
screenshots of IAM settings and half of them I take by hand every quarter.

💡 Textbook manual-evidence pain, venting publicly — no buying intent
   yet but exactly our problem.

open →

Reply to this message with your text and I'll post it. /skip to drop it.
```

**Reply to that message** with what you want to say. That's it — writing the
reply *is* the approval, there's no second confirmation. It queues with a
randomised delay (60s–15min), then posts.

| Command | |
|---|---|
| *(reply to a card)* | posts your text on that thread, verbatim |
| `/skip` | as a reply to a card — drops it |
| `/undo` | cancels the most recent pending reply |
| `/status` | budgets, spend, queue depth, last poll per source |
| `/stats` | corpus size, answer rate, screening spend |
| `/pause` `/resume` | halt or restart polling |

The delay window doubles as your undo window. It's also why replies don't look
automated — a reply landing four seconds after the parent reads as a bot no
matter how well written it is.

On Cloud Run the delay is also bounded below by the publish job's cadence: a
reply can't fire before the next 2-minute tick.

---

## Not hammering the APIs

Five mechanisms, because this is the thing most likely to get you rate-limited
or billed unexpectedly:

**1. Cursor-based polling.** Every source keeps its position in Postgres and
asks only for items newer than the last one it saw. After the first run, a
quiet subreddit costs one request that returns an empty listing. Steady-state
cost tracks *new matches*, not poll frequency.

**2. Per-source intervals.** The scheduler ticks every 5 minutes but each
source only polls once its own `pollMinutes` has elapsed, so five subreddits
spread across ticks instead of bursting.

**3. Hard budget ceilings.** Per hour, per day, and for X also per month. When
one is hit that source **stops** until the window rolls over — it doesn't slow
down or degrade. A runaway poller that "only" doubles its rate is exactly how a
month of X quota disappears in an afternoon, and it's silent until the invoice
arrives. Counters live in the database, so a crash loop can't reset them.

**4. Fetch sizing against remaining headroom.** X never asks for more tweets
than the tightest remaining window can pay for. Without that, one poll near the
daily edge overshoots by up to 99 reads.

**5. Exponential per-source backoff.** A source that errors gets paused for 5,
10, 20… minutes up to 6 hours. A deleted or private subreddit stops costing a
request every 12 minutes forever.

Projected usage with the shipped config:

| | volume | cost |
|---|---|---|
| Reddit | ~25 req/hour | $0 |
| Threads | ~120 req/day | $0 |
| X *(if enabled)* | ≤200 tweets/day, ≤10 replies | ≤$34/mo |
| Screening | ≤200 posts/day | ≤$0.50/day ceiling |
| Cloud Run + Scheduler | ~20k invocations/mo | $0 (free tier) |

---

## Safety

Your text is never modified. The governor only decides **if** and **when**:

- Daily caps per platform, and minimum spacing plus randomised jitter
- Max 3 replies per subreddit per day — concentration reads as brigading
- 7-day author cooldown, so nobody gets pestered (skipped on LinkedIn, where
  someone commenting on your post is inviting a reply)
- Refuses text >85% similar to something you already posted — repetition is
  the strongest automated-spam signal on every platform
- Reads `/r/{sub}/about/rules` and refuses to name your company in a subreddit
  that bans self-promotion
- Only publishes inside your configured local hours
- Over the character limit? **Refused, not truncated** — a reply cut off
  mid-sentence is worse than no reply
- Warns before an X reply with a link costs you 13× a plain one

Publishing is **at-most-once**. An ambiguous failure (timeout, 5xx) is never
auto-retried; it parks and pings you to check the thread. A duplicate reply on
a stranger's post can't be undone and is the most recognisable bot behaviour
there is — a missed reply is the cheaper mistake.

---

## Phase 2 — when the corpus is big enough

Nothing drafts for you today; that was cut on purpose. When `corpus:stats`
shows ~150+ published replies:

1. `npm run corpus:export` → JSONL of (post, your_reply) pairs
2. Use the highest-scoring 20–30 as few-shots, or fine-tune on the whole set
3. Add a `draft` step between screening and the card
4. **Keep the flow identical** — the card arrives with a suggestion, you still
   reply with what actually goes out. `Reply.source` already distinguishes
   `manual` from a generated draft, so you can measure how often you accept a
   suggestion unchanged

Automate fully only once that acceptance rate is high enough that you'd have
sent the draft as-is anyway. The corpus keeps growing either way, because what
gets stored is still whatever you actually sent.

---

## Layout

```
flaww.config.ts         ← the file you edit
Dockerfile              two-stage, ~1s cold start
deploy/deploy.sh        idempotent Cloud Run + Scheduler setup
prisma/schema.prisma    Postgres schema
src/
  index.ts              boots the HTTP server, registers the webhook
  server.ts             /health, /telegram/<secret>, /tasks/*
  cycle.ts              runPollCycle / runPublishCycle / runHousekeeping
  lock.ts               Postgres mutex — stops two instances double-polling
  budget.ts             hard ceilings; X metered in tweets, not requests
  config.ts             config schema + validation
  state.ts              pause flag
  sources/
    reddit.ts           subreddit-scoped polling + comment posting
    threads.ts          keyword search + two-step reply publish
    x.ts                tag OR-query, tweet-metered, token rotation
    linkedin.ts         comments on your own posts only
  screen/
    prefilter.ts        free filtering: keywords, age, dupes, cooldowns
    prompt.ts           the screening prompt
    llm.ts              the ONLY provider call — change model shape here
    index.ts            ingest → prefilter → screen
  telegram/
    bot.ts              commands + the reply-to-a-card handler
    card.ts             card formatting, ping caps, expiry
  publish/
    governor.ts         decides if/when — never what
    index.ts            at-most-once publisher
  scripts/
    doctor.ts           pre-flight checks + cost projection
    run-once.ts         force a cycle by hand
    export-corpus.ts    JSONL export
    corpus-stats.ts     funnel + corpus health
```

---

## Things you may want to revisit

**The screening model ID is a config value.** `gpt-5.4-nano` is set from your
spec — verify the exact string against your provider's current model list and
run `npm run doctor` after changing it. If it needs a different request shape,
`src/screen/llm.ts` is the only file that changes.

**Cost accounting is an estimate.** `PRICE_PER_MTOK` in `src/screen/llm.ts` and
`X_PRICING` in `src/budget.ts` are set from published rates. Correct them once
you've seen a real invoice. The ceilings that actually protect you are
`budgets.llm.postsPerDay` and `budgets.x.tweetsPerDay`, which are counts and
can't drift.

**Threads publishing is two API calls** — create a media container, then
publish it. That's how the Threads (and Instagram) Graph API works; forgetting
the second call is the classic way to end up with a reply that silently never
appears. Worth verifying against current docs if replies stop landing.

**`LINKEDIN_VERSION` in `src/sources/linkedin.ts` is a dated string** (`202506`)
and stale versions start returning 426. Bump it when you renew app access.

**tsx runs the TypeScript directly in the container.** It adds ~200ms to cold
start, traded against not maintaining a build step. Swap in a real `tsc` build
if cold start ever becomes the bottleneck.
