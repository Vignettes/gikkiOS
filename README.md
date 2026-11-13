# gikkiOS
A self-hosted GitHub Pages site for user-facing tools that retain and reuse data across functionality.

## Outcomes

A low-friction tracker for outcomes and their milestones (financial, health and other kinds).
Data is pulled automatically and summarized as progress and health. Data is encrypted end to end:
GitHub stores only ciphertext, and decryption happens only in your browser.

- Design: [docs/DESIGN.md](docs/DESIGN.md)
- Example outcome schema: [docs/examples/outcome.example.yaml](docs/examples/outcome.example.yaml)

### What's here

| Path | What |
|---|---|
| `app/` | The Pages app: key setup, passphrase-locked keyring, decrypting dashboard, encrypted check-ins. Vanilla TypeScript, one runtime dependency (`age-encryption`) |
| `vault-template/` | Contents for your **private** vault repo: Apple Health ingest, run scrubbing, ciphertext guard, weekly review issue. Setup guide in its README |
| `.github/workflows/pages.yml` | Builds and deploys `app/` to Pages on push to `main` |

### Getting started

1. Create the private vault repo from `vault-template/` (see [its README](vault-template/README.md)).
2. In this repo: **Settings → Pages → Source: GitHub Actions**, then merge to `main`.
3. Open the Pages URL and complete setup: generate a key, connect the vault, choose a passphrase.

Local development: `cd app && npm ci && npm run dev` (tests: `npm test`).
