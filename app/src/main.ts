import { newIdentity, openJSON, recipientOf, sealJSON } from "./crypto";
import { todayLocal } from "./dates";
import { errorBox, guarded, h, val } from "./dom";
import type { SeriesIndex } from "./engine";
import { fmt, metricLabel } from "./metrics";
import { fetchBlob, listVault, pool, putFile } from "./github";
import { forgetDevice, hasKeyring, type Keyring, saveKeyring, unlockKeyring, validateKeyring } from "./keyring";
import { manualSnapshot, type MetricSummary, type Snapshot, summarize } from "./model";
import { emptyDoc, type OutcomesDoc } from "./outcomes";
import { type OutcomesCtx, outcomesSection } from "./views/outcomes";

const AUTO_LOCK_MS = 10 * 60_000;
const OUTCOMES_PATH = "config/outcomes.age";
const app = document.getElementById("app")!;
function render(...nodes: (Node | null)[]) { app.replaceChildren(...nodes.filter((n): n is Node => n !== null)); window.scrollTo(0, 0); }
const today = () => todayLocal();

// ---------- session ----------
let session: Keyring | null = null;
let idleTimer: number | undefined;
function lock() { session = null; location.reload(); } // reload drops all decrypted data from memory
function bumpIdle() { clearTimeout(idleTimer); idleTimer = window.setTimeout(lock, AUTO_LOCK_MS); }
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => session && bumpIdle(), { passive: true });

// ---------- setup ----------
function setupScreen() {
  const err = errorBox();
  let identity = "";
  let recipient = "";
  const keyOut = h("div");

  const showKey = (fresh: boolean) => {
    keyOut.replaceChildren(
      fresh ? h("p", {}, h("strong", {}, "Your secret key. "),
        "Store it offline now (password manager or paper). It is the only way to read your data, and it is shown once.") : "",
      fresh ? h("code", { class: "secret" }, identity) : "",
      fresh ? h("label", {}, h("input", { type: "checkbox", id: "saved", class: "inline" }), " I have stored the secret key offline") : "",
      h("p", {}, "Public key (add it to the vault's ", h("code", {}, "AGE_RECIPIENTS"), " secret):"),
      h("code", { class: "key" }, recipient),
    );
  };

  const gen = h("button", { class: "primary", onclick: async () => {
    ({ identity, recipient } = await newIdentity()); showKey(true);
  } }, "Generate new key");
  const imp = h("button", { onclick: async () => {
    err.textContent = "";
    try { identity = val("importKey"); recipient = await recipientOf(identity); showKey(false); }
    catch (e) { err.textContent = (e as Error).message; }
  } }, "Use this key");

  const save: HTMLButtonElement = h("button", { class: "primary", onclick: () => guarded(save, err, async () => {
    if (!identity) throw new Error("Generate or import a key first");
    const savedBox = document.getElementById("saved") as HTMLInputElement | null;
    if (savedBox && !savedBox.checked) throw new Error("Confirm you stored the secret key offline");
    if (val("pass") !== val("pass2")) throw new Error("Passphrases don't match");
    const extra = val("extraRecipients").split("\n").map((s) => s.replace(/#.*/, "").trim()).filter(Boolean);
    const k: Keyring = {
      identity, repo: val("repo"), branch: val("branch") || "main", token: val("token"),
      recipients: [...new Set([recipient, ...extra])],
    };
    validateKeyring(k);
    save.textContent = "Checking vault access…";
    await listVault(k); // fail early on bad repo/token
    save.textContent = "Encrypting keyring…";
    await saveKeyring(k, val("pass"));
    session = k; bumpIdle(); await dashboard();
  }).finally(() => { save.textContent = "Save & unlock"; }) }, "Save & unlock");

  render(
    h("h1", {}, "gikkiOS setup"),
    h("p", { class: "muted" }, "Everything here stays on this device, encrypted with your passphrase. GitHub only ever receives ciphertext."),
    h("section", { class: "card" },
      h("h2", {}, "1 · Encryption key"),
      h("div", { class: "row" }, gen),
      h("details", {}, h("summary", { class: "muted" }, "…or import an existing key (second device / restore)"),
        h("label", {}, "Secret key", h("textarea", { id: "importKey", autocomplete: "off", spellcheck: "false" })), imp),
      keyOut),
    h("section", { class: "card" },
      h("h2", {}, "2 · Private vault repo"),
      h("div", { class: "row" },
        h("label", {}, "Repo (owner/name)", h("input", { id: "repo", placeholder: "you/gikkiOS-vault", autocomplete: "off" })),
        h("label", {}, "Branch", h("input", { id: "branch", value: "main" }))),
      h("label", {}, "Fine-grained token (vault only: Contents + Issues read/write)",
        h("input", { id: "token", type: "password", autocomplete: "off", placeholder: "github_pat_…" })),
      h("label", {}, "Other recipients, one per line (other devices, paper backup)",
        h("textarea", { id: "extraRecipients", placeholder: "age1…  # paper backup" }))),
    h("section", { class: "card" },
      h("h2", {}, "3 · Device passphrase"),
      h("div", { class: "row" },
        h("label", {}, "Passphrase (12+ chars)", h("input", { id: "pass", type: "password", autocomplete: "new-password" })),
        h("label", {}, "Repeat", h("input", { id: "pass2", type: "password", autocomplete: "new-password" }))),
      h("p", {}, save), err),
  );
}

// ---------- unlock ----------
function unlockScreen() {
  const err = errorBox();
  const go: HTMLButtonElement = h("button", { class: "primary", type: "submit" }, "Unlock");
  const form = h("form", { onsubmit: (e: Event) => { e.preventDefault(); void guarded(go, err, async () => {
    go.textContent = "Unlocking…";
    session = await unlockKeyring(val("pass"));
    bumpIdle(); await dashboard();
  }).finally(() => { go.textContent = "Unlock"; }); } },
    h("label", {}, "Passphrase", h("input", { id: "pass", type: "password", autocomplete: "current-password", autofocus: true })),
    h("p", {}, go));
  const forget = h("button", { class: "danger", onclick: async () => {
    if (confirm("Remove the encrypted keyring from this device? You'll need your secret key to set it up again.")) {
      await forgetDevice(); location.reload();
    }
  } }, "Forget this device");
  render(h("h1", {}, "gikkiOS"), h("section", { class: "card" }, form, err), forget);
}

// ---------- dashboard ----------
function sparkline(s: MetricSummary): Node {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark"); svg.setAttribute("viewBox", "0 0 100 24"); svg.setAttribute("preserveAspectRatio", "none");
  const pts = s.series.slice(-30);
  if (pts.length < 2) return svg;
  const vs = pts.map((p) => p.value), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts.map((p, i) => `${(i / (pts.length - 1)) * 100},${22 - ((p.value - lo) / span) * 20}`).join(" "));
  svg.append(line);
  return svg;
}

function statusPill(s: MetricSummary) {
  if (s.latest.kind === "manual") return h("span", { class: "pill manual" }, "manual");
  return s.stale ? h("span", { class: "pill stale" }, `stale ${s.ageDays}d`) : h("span", { class: "pill fresh" }, "fresh");
}

interface Loaded {
  summaries: MetricSummary[];
  index: SeriesIndex;
  doc: OutcomesDoc;
  docSha?: string;
  docError?: string;
  status: string;
  warning?: string;
}
let loaded: Loaded | null = null;

async function loadVault(k: Keyring, progress: (s: string) => void): Promise<Loaded> {
  const files = await listVault(k);
  const dataFiles = files.filter((f) => f.path.startsWith("data/"));
  const cfg = files.find((f) => f.path === OUTCOMES_PATH);
  let done = 0, failed = 0;
  const snaps = await pool(dataFiles, 6, async (f) => {
    try { return await openJSON<Snapshot>(await fetchBlob(k, f.sha), k.identity); }
    catch { failed++; return null; }
    finally { progress(`Decrypting ${++done}/${dataFiles.length}…`); }
  });
  let doc = emptyDoc(), docError: string | undefined;
  if (cfg) {
    try { doc = await openJSON<OutcomesDoc>(await fetchBlob(k, cfg.sha), k.identity); }
    catch { docError = "Outcomes file could not be decrypted with this device's key. Editing is disabled to avoid overwriting it."; }
  }
  const summaries = summarize(snaps.filter((s): s is Snapshot => s !== null), today());
  return {
    summaries,
    index: new Map(summaries.map((s) => [s.metric, s.series])),
    doc, docSha: cfg?.sha, docError,
    status: `${dataFiles.length} encrypted snapshot(s) · ${summaries.length} metric(s)`,
    warning: failed ? `${failed} file(s) could not be decrypted with this device's key. Check that AGE_RECIPIENTS includes this device's public key.` : undefined,
  };
}

async function dashboard() {
  const k = session!;
  const status = h("p", { class: "muted" }, "Loading vault…");
  render(header(k), status);
  try {
    loaded = await loadVault(k, (s) => (status.textContent = s));
    showDashboard();
  } catch (e) {
    render(header(k), h("p", { class: "error" }, (e as Error).message));
  }
}

function header(k: Keyring) {
  return h("header", {}, h("div", {}, h("h1", {}, "gikkiOS"), h("span", { class: "muted" }, k.repo)),
    h("div", { class: "row" }, h("button", { onclick: () => void dashboard() }, "Refresh"), h("button", { onclick: lock }, "Lock")));
}

function outcomesCtx(k: Keyring, L: Loaded): OutcomesCtx {
  return {
    doc: L.doc, index: L.index, summaries: L.summaries, today: today(),
    mount: (node) => render(header(k), node),
    back: () => showDashboard(),
    save: async (doc, message) => {
      if (L.docError) throw new Error(L.docError);
      const sealed = await sealJSON(doc, k.recipients);
      L.docSha = await putFile(k, OUTCOMES_PATH, sealed, message, L.docSha);
      L.doc = doc;
      showDashboard();
    },
  };
}

function showDashboard() {
  const k = session!, L = loaded!;
  const summaries = L.summaries;

  const table = summaries.length
    ? h("table", {},
        h("thead", {}, h("tr", {}, ["Metric", "Latest", "Date", "Source", "Trend (30)", "Status"].map((t) => h("th", {}, t)))),
        h("tbody", {}, summaries.map((s) => h("tr", {},
          h("td", { title: s.metric }, metricLabel(s.metric)),
          h("td", { class: "num" }, fmt(s.latest.value, s.unit, s.metric)),
          h("td", {}, s.latest.t),
          h("td", { class: "muted" }, s.latest.source),
          h("td", {}, sparkline(s)),
          h("td", {}, statusPill(s))))))
    : h("p", { class: "muted" }, "No data yet. Record a check-in below, or set up the Apple Health Shortcut (vault README).");

  const ciErr = errorBox();
  const ciOk = h("p", { class: "ok" });
  const known = h("datalist", { id: "metrics" }, summaries.map((s) => h("option", { value: s.metric }, metricLabel(s.metric))));
  const save: HTMLButtonElement = h("button", { class: "primary", onclick: () => guarded(save, ciErr, async () => {
    ciOk.textContent = "";
    const metric = val("ciMetric"), t = val("ciDate") || today();
    const unit = val("ciUnit") || summaries.find((s) => s.metric === metric)?.unit || "";
    const raw = val("ciValue");
    if (raw === "") throw new Error("Enter a value");
    const snap = manualSnapshot(metric, Number(raw), unit, t);
    const [y, m, d] = t.split("-");
    await putFile(k, `data/${y}/${m}/${d}-manual-${Date.now()}.age`, await sealJSON(snap, k.recipients), "check-in: manual");
    ciOk.textContent = "Saved (encrypted).";
    setTimeout(() => void dashboard(), 600);
  }) }, "Save check-in");

  // Suggest metrics that outcomes track but that have no data yet.
  const tracked = new Set(L.doc.outcomes.filter((o) => !o.archived).flatMap((o) => o.milestones.flatMap((m) => ("metric" in m ? [m.metric] : []))));
  const missing = [...tracked].filter((m) => !L.index.has(m));

  render(
    header(k),
    h("p", { class: "muted" }, `${L.status} · ${L.doc.outcomes.filter((o) => !o.archived).length} outcome(s)`),
    L.warning ? h("p", { class: "error" }, L.warning) : null,
    L.docError ? h("p", { class: "error" }, L.docError) : null,
    outcomesSection(outcomesCtx(k, L)),
    h("section", { class: "card" },
      h("h2", {}, "Check-in"),
      missing.length ? h("p", { class: "muted" }, "Waiting for data: ", missing.map(metricLabel).join(", ")) : null,
      known,
      h("div", { class: "row" },
        h("label", {}, "Metric", h("input", { id: "ciMetric", list: "metrics", placeholder: missing[0] ?? "finance.emergency_fund", autocomplete: "off" })),
        h("label", {}, "Value", h("input", { id: "ciValue", inputmode: "decimal", autocomplete: "off" })),
        h("label", {}, "Unit", h("input", { id: "ciUnit", placeholder: "USD", autocomplete: "off" })),
        h("label", {}, "Date", h("input", { id: "ciDate", type: "date", value: today() }))),
      h("p", {}, save), ciErr, ciOk),
    h("details", { class: "card" }, h("summary", {}, `Metrics (${summaries.length})`), table),
    h("details", { class: "card" },
      h("summary", {}, "Keys on this device"),
      h("p", { class: "muted" }, "New data is encrypted to these public keys. The vault's AGE_RECIPIENTS secret should list the same ones."),
      k.recipients.map((r) => h("p", {}, h("code", { class: "key" }, r)))),
  );
}

// ---------- boot ----------
(async () => {
  if (!crypto?.subtle) { render(h("p", { class: "error" }, "This browser lacks WebCrypto; use a current browser over HTTPS.")); return; }
  (await hasKeyring()) ? unlockScreen() : setupScreen();
})();
