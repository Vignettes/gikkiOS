# gikkiOS vault (template)

Copy this folder into a new **private** repository (e.g. `gikkiOS-vault`). It holds only age
ciphertext plus the workflows that write it. See `docs/DESIGN.md` in the gikkiOS app repo.

```
data/YYYY/MM/DD-<source>-<run>.age   append-only encrypted snapshots
config/*.age                         encrypted config (outcomes, later phases)
scripts/                             ingest + guard (Node 22, one dependency: age-encryption)
.github/workflows/
  ingest-health.yml   repository_dispatch "health" → validate → encrypt → commit
  scrub-runs.yml      deletes each finished ingest run (removes plaintext dispatch payload)
  guard.yml           fails if anything under data/ or config/ isn't ciphertext
  weekly-review.yml   opens a content-free "Weekly review ready" issue every Sunday
```

## Setup

1. **Create the private repo** from this folder:
   ```sh
   cp -r vault-template ~/gikkiOS-vault && cd ~/gikkiOS-vault
   git init -b main && git add -A && git commit -m "vault" && git remote add origin git@github.com:<you>/gikkiOS-vault.git && git push -u origin main
   ```
2. **Generate your key** in the gikkiOS app (Setup screen). Write down the secret key
   (`AGE-SECRET-KEY-1…`) offline. Without it the data cannot be recovered.
   Optionally also make a paper backup key with the age CLI: `age-keygen -o backup.txt`.
3. **Settings → Environments → New environment `ingest`**. Add secret `AGE_RECIPIENTS`: the
   `age1…` public keys, one per line (app key, backup key, other devices). Under deployment
   branches, allow only `main`.
4. **Settings → Secrets and variables → Actions → Variables**: `GIKKIOS_APP_URL` = your Pages URL.
5. **Settings → Actions → General**: Workflow permissions = *Read repository contents*
   (the workflows request write scopes per job).
6. **Create fine-grained PATs** (Settings → Developer settings → Fine-grained tokens), each limited to
   *only* the vault repo, with an expiry of 1 year or less:
   - **App token**: Contents *read & write*, Issues *read & write*. Paste it into the app's setup screen.
   - **Phone token**: Contents *read & write* only (needed for `repository_dispatch`). Goes in the Shortcut.

## Apple Health Shortcut

Create a personal automation: **Time of Day 21:00, daily, Run Immediately**. Actions:

1. For each metric below: **Find Health Samples** where *Type* is X and *Start Date is today*, then
   **Calculate Statistics** (Sum or Average) → store in a variable. Leave blank if no samples.

   | key | Health type | statistic |
   |---|---|---|
   | `steps` | Steps | Sum |
   | `rhr` | Resting Heart Rate | Average |
   | `hrv` | Heart Rate Variability | Average |
   | `sleep_h` | Sleep Analysis (Asleep), start date = yesterday 18:00 | Sum of duration, in hours |
   | `weight_kg` | Weight | Latest (kg) |
   | `active_kcal` | Active Energy | Sum |
   | `exercise_min` | Exercise Minutes | Sum |
   | `workouts` | Workouts | Count |

2. **Format Date** (Current Date, custom `yyyy-MM-dd`) → `d`.
3. **Get Contents of URL**:
   - URL: `https://api.github.com/repos/<you>/gikkiOS-vault/dispatches`
   - Method: POST. Headers: `Authorization: Bearer <phone token>`, `Accept: application/vnd.github+json`
   - Request body (JSON):
     ```json
     { "event_type": "health", "client_payload": { "d": "<d>", "m": { "steps": "<steps>", "rhr": "<rhr>", "...": "..." } } }
     ```
   GitHub replies `204 No Content` on success.

Only the keys in the table are accepted. Unknown keys or out-of-range values fail the run, and nothing
is written. The ingest run is then deleted by `scrub-runs.yml`, so a failure shows up in the app as a
**stale** source, not as a kept error log.

## Local checks

```sh
npm ci --ignore-scripts && npm test && npm run check
```
