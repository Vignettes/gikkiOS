# gikkiOS — Outcomes: Design

Status: draft v0.2 · 2026-11-13. Decisions in §9 resolved.

## 1. Problem

Setting an outcome ("be debt-free by 2028", "run a half marathon") is easy. Keeping
track of it is not. You have to update spreadsheets by hand, gather numbers from bank and
health apps, and work out whether you are on pace. This design removes most of that work:

- **Set** an outcome in under two minutes from a template. Milestones are suggested for you.
- **Track** with data pulled automatically, and with manual check-ins only when a source
  cannot be automated.
- **Understand** where things stand at a glance: on track / at risk / off track, plus a
  plain-language weekly summary.
- **Protect** financial and health data so that a leak of any one part (the public site,
  the repo, a workflow run, a lost laptop) does not expose readable personal data.

Constraint: hosted on GitHub (Pages + Actions), with no servers or databases of its own.

## 2. Core idea

> **GitHub Actions ingests and encrypts. The browser decrypts, evaluates and summarizes.
> GitHub only ever stores ciphertext.**

```
 ┌────────────────────────── private repo: gikkiOS-vault ─────────────────────────┐
 │                                                                                  │
 │  Actions (cron, e.g. 06:00 daily)                                                │
 │   ├─ connector: finance (Plaid / OFX-CSV)          ─┐                            │
 │   ├─ connector: health  (Apple Health via dispatch) ├─► normalize ─► encrypt ─┐  │
 │   ├─ connector: activity (Strava / GitHub / ...)    │    to metric   (age,    │  │
 │   └─ inbox: repository_dispatch (iOS Shortcut,     ─┘    points    public    │  │
 │            Apple Health export, manual check-in)                   key only)  │  │
 │                                                                               ▼  │
 │   data/  YYYY/MM/DD-<connector>-<runid>.age   (append-only snapshots)            │
 │   config/outcomes.age                         (outcomes, milestones, bindings)   │
 └──────────────────────────────────────────┬───────────────────────────────────────┘
                                            │ GitHub API + fine-grained PAT (vault only)
 ┌──────────────── public repo: gikkiOS (this repo) → GitHub Pages ────────────────┐
 │  Static app shell (no data, no secrets)                                          │
 │   unlock (passphrase → age identity) → fetch ciphertext → decrypt in memory      │
 │   → merge time series → evaluate milestones → dashboard + weekly summary         │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Why this split:

| Concern | Decision | Reason |
|---|---|---|
| Pages sites are always public, even from a private repo | The Pages site holds **only app code**. Data is never published to Pages | Nothing sensitive can be served publicly by accident |
| Data at rest on GitHub | Encrypted with [age](https://age-encryption.org) (X25519) **and** kept in a private repo | Two independent layers: access control plus encryption |
| Actions needs to write data but should not read history | Actions holds only the **public** recipient key | If a workflow or secret is compromised, it sees at most the current run's pull, not past data |
| Evaluation needs history | Done **client-side** after decryption | No server-side key is needed. Removing it is the biggest security gain |
| Writes from the browser (new outcomes, check-ins) | Fine-grained PAT with `contents:write` on the vault repo only, stored passphrase-wrapped in IndexedDB | Narrowest token GitHub offers |

## 3. Domain model

```
Outcome ──< Milestone ──> Metric ──> Source binding (connector + query)
   │            │            └─< MetricPoint (t, value, source, quality)
   │            └─ target, comparator, due, weight
   └─ why, horizon, category (finance | health | learning | other), status
```

- **Outcome**: the end state, plus a short *why*. The why appears in summaries, to keep motivation in view.
- **Milestone**: a measurable checkpoint on the way. Examples: `emergency_fund >= 15000 by 2027-06-30`,
  `resting_hr_30d_avg <= 58 by 2027-03-01`. A milestone can be:
  - `threshold`: value crosses a target
  - `cumulative`: a sum over a window, e.g. 120 km run in Q1
  - `streak` / `frequency`: e.g. ≥ 4 workouts/week for 8 weeks
  - `boolean`: a manual "done" (e.g. "open a Roth IRA")
- **Metric**: a named, unit-typed time series built from one or more sources. It can also be
  derived, e.g. `net_worth = sum(assets) - sum(liabilities)`, or `savings_rate`.
- **MetricPoint**: one normalized observation. Every point records its source and whether it was
  `auto` or `manual`. This keeps provenance visible.

The schema is in `docs/examples/outcome.example.yaml`. It is stored encrypted as
`config/outcomes.age` and edited through the app, not by hand.

## 4. Data ingestion (connectors)

Each connector is a small, dependency-light module with one contract:

```ts
interface Connector {
  id: string;                       // "simplefin", "oura", ...
  secrets: string[];                // Actions secret names it needs
  pull(since: Date): Promise<MetricPoint[]>;   // never logs payloads
}
```

Chosen connectors:

| Domain | Source | Notes |
|---|---|---|
| Finance | **Plaid** (primary) | Chosen for coverage of smaller banks and credit unions. Needs a Plaid developer account and production access approval. Check current pricing and limits for personal use before committing |
| Finance | OFX/QFX/CSV drop | Fallback for any institution Plaid doesn't reach. Upload in the app; encrypted in the browser before upload |
| Health | **Apple Health** | No cloud API. An iOS Shortcut posts daily aggregates to `repository_dispatch` (see §4.2) |
| Any | Manual check-in | One-tap entry in the app, encrypted client-side and committed through the PAT |

Later candidates: Oura, Withings, Fitbit, Strava (OAuth APIs), SimpleFIN as a cheaper secondary aggregator.

### 4.1 Plaid setup (one time, local)

Plaid Link's token exchange needs the Plaid `secret`, which must never reach the browser or the
public Pages site. Linking is therefore a **one-time local script**:

1. `node vault/scripts/plaid-link.mjs` starts a localhost-only page with Plaid Link.
2. You log in to each bank. The script exchanges `public_token` → `access_token` locally.
3. You save the `access_token`s as the Actions secret `PLAID_ACCESS_TOKENS` (JSON array) in the
   `ingest` environment. Nothing is written to disk.

The daily job calls `/accounts/balance/get` (or the cheaper `/accounts/get` cached balances) and keeps
**balances per account per day only**. Transactions are not pulled unless a milestone needs them
(e.g. a spending cap). Even then, they are aggregated to category totals per day before encryption.

### 4.2 Apple Health path

```
iPhone (Shortcut, daily automation at 21:00)
  └─ Find Health Samples (steps, resting HR, sleep, weight, workouts) → daily aggregates
  └─ POST https://api.github.com/repos/<you>/gikkiOS-vault/dispatches
       { "event_type": "health", "client_payload": { "d": "2026-11-13", "m": { "rhr": 57, ... } } }
         Authorization: fine-grained PAT, vault repo only, Contents: write
GitHub Actions (on: repository_dispatch)
  └─ validate schema → encrypt with AGE_RECIPIENT → commit data/YYYY/MM/DD-apple_health-<run>.age
  └─ delete its own workflow run (removes the plaintext event payload from run history)
```

Trade-off: the dispatch payload is plaintext inside GitHub until the run deletes itself, usually under
a minute, and only in the private repo. Payloads are limited to daily aggregates. The phone holds a PAT
that can write to the vault. Set it to expire (≤ 1 year) and revoke it if the phone is lost.
Alternative: the Health Auto Export app can do the same POST with less Shortcut wiring.

Ingestion rules:
- **Pull aggregates, not raw records**: daily balances rather than transactions, daily averages
  rather than heart-rate samples. Store the least data that answers the milestone.
- Plaintext exists only in runner memory. Payloads are never `echo`ed, written to artifacts, or cached.
  Secret values are masked with `::add-mask::`.
- Writes are append-only, one file per run. This avoids merge conflicts and gives a natural audit trail.
  A monthly compaction job runs in the browser on the user's request.

## 5. Evaluation & summaries ("health and progress")

All evaluation runs in the browser after unlock.

**Milestone status by pace projection.** For each milestone:

1. `required_rate = (target − current) / time_remaining`
2. `actual_rate` = slope of an EWMA over a lookback window (default 28 days; configurable per metric)
3. `projected = current + actual_rate × time_remaining`
4. Status:
   - 🟢 **on track** if the projection meets the target
   - 🟡 **at risk** if it reaches ≥ 85% of the required progress
   - 🔴 **off track** otherwise
   - ⚪ **stale** if no data has arrived within 2× the expected cadence. This is a data problem, not a goal problem

**Outcome health** is the weighted roll-up of its milestones. Status changes are highlighted.

**Weekly review** (the only notification):
- A weekly scheduled workflow in the vault (Sunday 17:00 local) opens an issue titled
  `Weekly review ready`, with **no content** besides a link to the app. GitHub's own notification
  (email/mobile app) delivers it. The workflow needs no decryption key.
- The issue is closed automatically when you complete the review in the app (via the PAT), so open
  issues double as "reviews missed".
- The review screen shows, in order: status changes since last week, at-risk/off-track milestones with
  "what would get you back on track" (e.g. "+$410/mo savings, or move the date to Aug 2027"),
  stale sources, pending manual check-ins, and a single "next action" field you write yourself.
  Target: 2 minutes.

**AI narrative** is not built for now. If added later it stays **off by default**: your own API key,
called from the browser, sending derived numbers only (status, rates, percentages).

**Friction reducers**:
- Outcome templates (emergency fund, debt payoff, net-worth target, weight/body comp, resting HR,
  sleep consistency, race training) with milestones generated from a target and date.
- Check-ins happen only by exception: you are asked only when a milestone is manual or a source is stale.
- Reviews follow a cadence (weekly 2-minute review, quarterly re-plan) rather than daily logging.

## 6. Security model

### Threats and mitigations

| Threat | Mitigation |
|---|---|
| Public Pages site is scraped | It contains no data. A strict CSP (`default-src 'self'; connect-src https://api.github.com`), no third-party scripts, and SRI on all assets |
| Vault repo exposed (misconfig, leaked PAT, GitHub breach) | Everything in it is age ciphertext. File names reveal only date and connector |
| Malicious or compromised GitHub Action | The ingest job uses **no third-party actions**, only first-party actions pinned by commit SHA. `permissions: contents: write` on that job only. Dependabot and pinned lockfiles |
| Actions secret leak | Read-only connector credentials (Plaid access tokens cannot move money without separately enabled products). Secrets live in a protected `ingest` environment. Quarterly rotation reminder |
| Workflow compromised later | It holds only the public key, so it cannot decrypt history. Exposure is limited to future pulls until the secret is revoked |
| Lost or stolen device | The age identity is wrapped with your passphrase (scrypt) in IndexedDB. Auto-lock after inactivity. Decrypted data is kept in memory only, never in localStorage |
| Forgotten passphrase or lost key | An offline backup of the age identity (printed or in a password manager). There is **no recovery without it**, by design |
| Metadata leakage | Snapshot sizes are padded to buckets. Connector names can be pseudonymized if you want that |
| Accidental plaintext commit | A pre-commit/CI guard rejects any file under `data/` or `config/` that does not start with the age header |

### Key handling
- `age-keygen` runs once, locally or in the app. The **public** recipient goes into Actions secret
  `AGE_RECIPIENT`. The **private** identity never touches GitHub.
- Multiple recipients are supported: for example, a laptop key, a phone key and a paper backup key.
  Data is encrypted to all of them, so each device unlocks independently and one device can be revoked
  by re-encrypting to the remaining keys.

### Out of scope / accepted risks
- GitHub can see access patterns and timing.
- A compromised browser or extension on an unlocked device can read decrypted data. Mitigation: use a dedicated browser profile.
- Third-party data providers (Plaid, your banks, Apple) hold your data under their own terms.

## 7. Repository layout

```
gikkiOS/                 (public, Pages)          gikkiOS-vault/            (private)
├─ app/      SPA source                           ├─ .github/workflows/
│  ├─ crypto/   age (typage), key wrap            │  ├─ ingest.yml       cron + dispatch
│  ├─ engine/   metrics, pace, status             │  └─ guard.yml        ciphertext-only check
│  ├─ ui/       dashboard, wizard, check-in       ├─ connectors/        one file per source
│  └─ vault/    GitHub API client (PAT)           ├─ config/outcomes.age
├─ templates/ outcome templates (no personal data)├─ data/YYYY/MM/*.age
└─ docs/                                          └─ README.md
```

Stack suggestion: TypeScript throughout, so connectors and the app share types. Vite plus a small
framework (Preact or Svelte) for the app, and [`typage`](https://github.com/FiloSottile/typage)
for age in both the browser and Node. Connectors run on Node 22 in Actions. Total runtime
dependencies are kept deliberately small to limit supply-chain exposure.

## 8. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundations** ✅ | Key setup flow, vault repo template, encrypt/decrypt round-trip, ciphertext guard | Encrypted manual check-in visible on the dashboard |
| **1 — Manual MVP** | Outcome/milestone model, templates, pace engine, dashboard | Track 2–3 outcomes end to end with manual data |
| **2 — Apple Health** 🟡 ingest built; Shortcut and metrics UI to test | Shortcut → dispatch ingest, self-deleting run, sleep/HR/weight/workout metrics | Health milestones update automatically |
| **3 — Plaid** | Local link script, daily balance pull, net worth / savings / debt metrics, OFX/CSV fallback | Daily balances arrive without touching anything |
| **4 — Weekly review** | Content-free review issue, review screen, "back on track" suggestions | A 2-minute weekly review replaces manual tallying |
| **5 — Hardening** | Multi-device keys, key rotation, padding, compaction, backup/restore drill | A documented and tested recovery from a lost device |

## 9. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Repo layout | **Two repos**: public `gikkiOS` (app on Pages) + private `gikkiOS-vault` (ciphertext, ingest workflows, secrets) |
| 2 | Finance aggregator | **Plaid**, for smaller banks; OFX/CSV fallback |
| 3 | Health sources | **Apple Health** via iOS Shortcut |
| 4 | Notifications | **Weekly review** issue with no content; no server-side decryption |
| 5 | AI summaries | Not built now; off by default if ever added |
