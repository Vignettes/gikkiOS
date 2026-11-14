import { addMonths, relDays, shortDate, todayLocal } from "../dates";
import { bound, errorBox, guarded, h, optNum, select } from "../dom";
import { evaluateOutcome, smoothSeries, type MilestoneEval, type OutcomeEval, type PathEval, type SeriesIndex, type Status, STATUS_LABEL, STATUS_TONE, type Tone } from "../engine";
import { decimalsFor, fmt, METRICS, metricLabel } from "../metrics";
import type { MetricSummary } from "../model";
import {
  CATEGORIES, KINDS, type Milestone, type MilestoneKind, milestoneLabel, newId, type Outcome, type OutcomesDoc, validateOutcome,
} from "../outcomes";
import { blankOutcome, fromTemplate, type Template, TEMPLATES } from "../templates";

export interface OutcomesCtx {
  doc: OutcomesDoc;
  index: SeriesIndex;
  summaries: MetricSummary[];
  today: string;
  save(doc: OutcomesDoc, message: string): Promise<void>; // encrypts, writes, re-renders dashboard
  log(metric: string, value: number, unit: string, date: string): Promise<void>; // one encrypted reading
  mount(node: Node): void;                                  // replace the main view
  back(): void;                                             // return to dashboard
}

const SEVERITY: Status[] = ["missed", "off_track", "at_risk", "stale", "no_data", "on_track", "achieved"];
const tone = (s: Status) => `t-${STATUS_TONE[s]}`;
const pill = (s: Status) => h("span", { class: `pill ${tone(s)}` }, STATUS_LABEL[s]);
const bar = (p: number, s: Status) =>
  h("div", { class: "bar", role: "progressbar", "aria-valuenow": Math.round(p * 100), "aria-valuemin": 0, "aria-valuemax": 100 },
    h("span", { class: tone(s), "data-w": Math.round(p * 100) }));

/** Sets bar widths without inline style attributes (blocked by CSP): uses CSSOM, which CSP allows. */
function sizeBars(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".bar > span[data-w]").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
}

const clone = <T>(x: T): T => structuredClone(x);
const expanded = new Set<string>(); // outcome ids whose milestone list is open; survives re-renders

// ---------------- dashboard section ----------------

export function outcomesSection(ctx: OutcomesCtx): Node {
  const active = ctx.doc.outcomes.filter((o) => !o.archived);
  const archived = ctx.doc.outcomes.filter((o) => o.archived);
  const evals = active
    .map((o) => evaluateOutcome(o, ctx.index, ctx.today, ctx.doc.settings))
    .sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || a.outcome.horizon.localeCompare(b.outcome.horizon));

  // Summary strip counts by what the user sees (label + colour), worst first.
  const counts = new Map<string, { n: number; t: Tone }>();
  for (const s of SEVERITY) for (const e of evals) if (e.status === s) {
    const k = STATUS_LABEL[s];
    counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, t: STATUS_TONE[s] });
  }

  const section = h("section", { class: "outcomes" },
    h("header", {},
      h("h2", {}, "Outcomes"),
      h("div", { class: "row" },
        ...[...counts].map(([label, c]) => h("span", { class: `pill t-${c.t}` }, `${c.n} ${label}`)),
        h("button", { class: "primary", onclick: () => openWizard(ctx) }, "New outcome"))),
    evals.length ? evals.map((e) => outcomeCard(ctx, e))
      : h("div", { class: "card empty" },
          h("p", {}, "No outcomes yet. Start from a template: it suggests milestones from your target and date."),
          h("button", { class: "primary", onclick: () => openWizard(ctx) }, "Set your first outcome")),
    archived.length ? h("details", { class: "card" },
      h("summary", {}, `Archived (${archived.length})`),
      archived.map((o) => h("div", { class: "row between" },
        h("span", {}, o.title),
        h("span", { class: "row" },
          h("button", { onclick: () => mutate(ctx, `outcome: unarchive`, (d) => { find(d, o.id).archived = false; }) }, "Restore"),
          h("button", { class: "danger", onclick: () => {
            if (confirm(`Delete "${o.title}" permanently? Its metric data stays.`)) {
              void mutate(ctx, "outcome: delete", (d) => { d.outcomes = d.outcomes.filter((x) => x.id !== o.id); });
            }
          } }, "Delete"))))) : null,
  );
  queueMicrotask(() => sizeBars(section));
  return section;
}

function find(d: OutcomesDoc, id: string): Outcome {
  const o = d.outcomes.find((x) => x.id === id);
  if (!o) throw new Error("Outcome not found; refresh");
  return o;
}

async function mutate(ctx: OutcomesCtx, message: string, fn: (d: OutcomesDoc) => void) {
  const d = clone(ctx.doc);
  fn(d);
  try { await ctx.save(d, message); } catch (e) { alert((e as Error).message); }
}

const PATH_ICON = { met: "✓", missed: "✗", next: "→", upcoming: "○" } as const;

/** "✓ $4,500 Feb 13 · → $7,000 May 13 · ○ $9,500 Aug 13 · ◎ $12,000 Nov 13" */
function pathChips(e: MilestoneEval, path: PathEval): Node {
  const m = e.milestone as Extract<Milestone, { kind: "threshold" | "cumulative" }>;
  const unit = METRICS[m.metric]?.unit ?? e.unit ?? "";
  return h("ol", { class: "path", "aria-label": "Checkpoints" },
    path.points.map((p) => h("li", { class: `cp ${p.state}`, title: p.state },
      `${PATH_ICON[p.state]} ${fmt(p.target, unit, m.metric)}`, h("span", { class: "muted" }, ` ${shortDate(p.due)}`))),
    h("li", { class: "cp goal" }, `◎ ${fmt(m.target, unit, m.metric)}`, h("span", { class: "muted" }, ` ${shortDate(m.due)}`)));
}

/** One line for the card: the next checkpoint and how the value compares with the plan. */
function planLine(e: MilestoneEval): Node | null {
  const path = e.path;
  if (!path || e.status === "achieved" || (!path.next && !path.note)) return null;
  const m = e.milestone as Extract<Milestone, { kind: "threshold" | "cumulative" }>;
  const unit = METRICS[m.metric]?.unit ?? e.unit ?? "";
  return h("div", { class: "planline" },
    h("span", { class: "muted" }, `${metricLabel(m.metric)}: `),
    path.next ? `next checkpoint ${fmt(path.next.target, unit, m.metric)} by ${shortDate(path.next.due)}` : `final stretch to ${fmt(m.target, unit, m.metric)}`,
    path.note ? h("span", { class: /behind/.test(path.note) ? "behind" : "ahead" }, ` · ${path.note}`) : null);
}

function milestoneRow(ctx: OutcomesCtx, o: Outcome, e: MilestoneEval, isNext: boolean): Node {
  const m = e.milestone;
  return h("li", { class: isNext ? "next" : "" },
    h("div", { class: "row between" },
      h("span", {}, h("strong", {}, milestoneLabel(m)), h("span", { class: "muted" }, ` · due ${shortDate(m.due)}`)),
      h("span", { class: "row" },
        m.kind === "boolean" && !m.done
          ? h("button", { class: "small", onclick: () => mutate(ctx, "milestone: done", (d) => {
              const t = find(d, o.id).milestones.find((x) => x.id === m.id) as Extract<Milestone, { kind: "boolean" }>;
              t.done = true; t.done_at = todayLocal();
            }) }, "Mark done")
          : null,
        pill(e.status))),
    h("div", { class: "muted" }, e.summary),
    e.hint && e.status !== "achieved" ? h("div", { class: "hint" }, e.hint) : null,
    e.path ? pathChips(e, e.path) : null,
  );
}

/** Metrics this outcome needs typed in: no data yet, or last reading was manual. */
export function manualMetrics(o: Outcome, summaries: MetricSummary[]): string[] {
  const ids = [...new Set(o.milestones.flatMap((m) => ("metric" in m ? [m.metric] : [])))];
  return ids.filter((id) => {
    const s = summaries.find((x) => x.metric === id);
    return !s || s.latest.kind === "manual";
  });
}

function logPanel(ctx: OutcomesCtx, o: Outcome): Node | null {
  const metrics = manualMetrics(o, ctx.summaries);
  if (!metrics.length) return null;
  const panel = h("div", { class: "log" });
  const buttons = () => panel.replaceChildren(h("div", { class: "row" },
    metrics.map((id) => h("button", { class: "small", onclick: () => form(id) }, `Log ${metricLabel(id).toLowerCase()}`))));
  const form = (id: string) => {
    const s = ctx.summaries.find((x) => x.metric === id);
    const unit = METRICS[id]?.unit ?? s?.unit ?? "";
    const err = errorBox();
    const value = h("input", { inputmode: "decimal", autocomplete: "off", "aria-label": metricLabel(id), placeholder: s ? fmt(s.latest.value, unit, id).replace(/[^\d.,-]/g, "") : "" });
    const date = h("input", { type: "date", value: ctx.today, "aria-label": "Date" });
    const unitIn = unit ? null : h("input", { placeholder: "unit", "aria-label": "Unit", class: "unit" });
    const save: HTMLButtonElement = h("button", { class: "primary small", type: "submit" }, "Save");
    const submit = (ev: Event) => { ev.preventDefault(); void guarded(save, err, async () => {
      const raw = value.value.trim().replace(/[$,\s]/g, "");
      if (raw === "" || !Number.isFinite(Number(raw))) throw new Error("Enter a number");
      save.textContent = "Saving…";
      await ctx.log(id, Number(raw), unit || unitIn!.value.trim(), date.value || ctx.today);
    }).finally(() => { save.textContent = "Save"; }); };
    panel.replaceChildren(h("form", { class: "logform", onsubmit: submit },
      h("strong", {}, metricLabel(id)),
      h("div", { class: "row" },
        h("span", { class: "valwrap" }, unit === "USD" ? h("span", { class: "muted" }, "$") : null, value,
          unit && unit !== "USD" && unit !== "count" ? h("span", { class: "muted" }, unit) : null),
        unitIn, date, save,
        h("button", { class: "small", type: "button", onclick: buttons }, "Cancel")),
      s ? h("div", { class: "muted" }, `Last: ${fmt(s.latest.value, unit, id)}, ${shortDate(s.latest.t, ctx.today)}`) : null,
      err));
    value.focus();
  };
  buttons();
  return panel;
}

function outcomeCard(ctx: OutcomesCtx, e: OutcomeEval): Node {
  const o = e.outcome;
  return h("article", { class: `card outcome b-${STATUS_TONE[e.status]}` },
    h("div", { class: "row between" },
      h("div", {}, h("h3", {}, o.title), h("span", { class: "muted" }, `${o.category} · by ${shortDate(o.horizon, ctx.today)} (${relDays(o.horizon, ctx.today)})`)),
      pill(e.status)),
    o.why ? h("p", { class: "why" }, o.why) : null,
    h("div", { class: "row between progress" }, bar(e.progress, e.status), h("span", { class: "muted" }, `${Math.round(e.progress * 100)}%`)),
    e.next ? h("div", { class: "nextline" },
      h("span", { class: "muted" }, "Next: "), milestoneLabel(e.next.milestone), h("span", { class: "muted" }, ` · ${shortDate(e.next.milestone.due, ctx.today)} `),
      e.next.hint ? h("div", { class: "hint" }, e.next.hint) : null) : h("p", { class: "ok" }, "All milestones achieved 🎉"),
    e.milestones.map(planLine),
    logPanel(ctx, o),
    h("details", { open: expanded.has(o.id), ontoggle: (ev: Event) => {
      if ((ev.target as HTMLDetailsElement).open) expanded.add(o.id); else expanded.delete(o.id);
    } },
      h("summary", {}, `Milestones (${e.milestones.filter((m) => m.status === "achieved").length}/${e.milestones.length} achieved)`),
      h("ul", { class: "milestones" }, e.milestones.map((m) => milestoneRow(ctx, o, m, m === e.next))),
      h("div", { class: "row" },
        h("button", { onclick: () => openEditor(ctx, clone(o), false) }, "Edit"),
        h("button", { onclick: () => mutate(ctx, "outcome: archive", (d) => { find(d, o.id).archived = true; }) }, "Archive"))),
  );
}

// ---------------- wizard ----------------

export function openWizard(ctx: OutcomesCtx) {
  ctx.mount(h("div", {},
    h("header", {}, h("h1", {}, "New outcome"), h("button", { onclick: () => ctx.back() }, "Cancel")),
    h("p", { class: "muted" }, "Pick a starting point. You can change everything on the next screen."),
    h("div", { class: "templates" },
      TEMPLATES.map((t) => h("button", { class: "tile", onclick: () => templateForm(ctx, t) },
        h("strong", {}, t.label), h("span", { class: "muted" }, t.category))),
      h("button", { class: "tile", onclick: () => openEditor(ctx, blankOutcome(), true) },
        h("strong", {}, "Blank"), h("span", { class: "muted" }, "anything else"))),
  ));
}

function templateForm(ctx: OutcomesCtx, t: Template) {
  // Where you are today, from your data: the same smoothed value the engine will use.
  const series = ctx.index.get(t.metric) ?? [];
  const known = series.length ? smoothSeries(series, t.smooth).at(-1)!.v : undefined;
  const f = 10 ** decimalsFor(t.unit, t.metric);
  const latest = known === undefined ? undefined : Math.round(known * f) / f;
  const state = {
    target: t.defaultTarget?.toString() ?? "",
    horizon: addMonths(ctx.today, t.kind === "frequency" ? 3 : 12),
    current: latest?.toString() ?? "",
    checkpoints: t.kind !== "frequency",
  };
  const err = errorBox();
  const cp = h("input", { type: "checkbox", class: "inline", checked: state.checkpoints });
  cp.addEventListener("change", () => { state.checkpoints = cp.checked; });
  const next: HTMLButtonElement = h("button", { class: "primary", onclick: () => guarded(next, err, async () => {
    const target = Number(state.target);
    if (state.target === "" || !Number.isFinite(target)) throw new Error(`${t.targetLabel} is required`);
    const current = optNum(state.current);
    if (t.needsCurrent && current === undefined) throw new Error("Enter where you are today");
    if (current !== undefined && !Number.isFinite(current)) throw new Error("Current value must be a number");
    openEditor(ctx, fromTemplate(t, { target, horizon: state.horizon, current, checkpoints: state.checkpoints, start: ctx.today }), true);
  }) }, "Next: review");

  const currentInput = () => bound("Where you are today", () => state.current, (v) => (state.current = v), { inputmode: "decimal", id: "tCurrent" });
  const knownLine = h("p", { class: "known" });
  if (latest !== undefined) {
    knownLine.append(
      "Today: ", h("strong", {}, fmt(latest, t.unit, t.metric)),
      h("span", { class: "muted" }, ` from your data (${t.smooth ? `${t.smooth}-day average, ` : ""}last reading ${shortDate(series.at(-1)!.t, ctx.today)}) `),
      h("button", { class: "small", onclick: () => knownLine.replaceChildren(currentInput()) }, "Change"));
  }

  ctx.mount(h("div", {},
    h("header", {}, h("h1", {}, t.label), h("button", { onclick: () => openWizard(ctx) }, "Back")),
    h("section", { class: "card" },
      h("div", { class: "row" },
        bound(t.targetLabel, () => state.target, (v) => (state.target = v), { inputmode: "decimal", id: "tTarget" }),
        bound("By", () => state.horizon, (v) => (state.horizon = v), { type: "date", id: "tHorizon" }),
        t.needsCurrent && latest === undefined ? currentInput() : null),
      t.needsCurrent && latest !== undefined ? knownLine : null,
      h("label", {}, cp, t.kind === "frequency" ? "Suggest checkpoints" : "Suggest checkpoints along the way"),
      h("p", { class: "muted" }, `Tracks ${metricLabel(t.metric).toLowerCase()}`,
        t.kind === "threshold" && t.smooth ? ` (${t.smooth}-day average)` : "",
        t.metric.startsWith("health.") ? ". Filled automatically by the Apple Health Shortcut." : ". Use check-ins until Plaid is connected."),
      h("p", {}, next), err),
  ));
}

// ---------------- editor ----------------

function newMilestone(kind: MilestoneKind, o: Outcome, prev?: Milestone): Milestone {
  const metric = prev && "metric" in prev ? prev.metric : "";
  const base = { id: newId("m"), due: o.horizon };
  switch (kind) {
    case "threshold": return { ...base, kind, metric, comparator: ">=", target: NaN };
    case "cumulative": return { ...base, kind, metric, target: NaN };
    case "frequency": return { ...base, kind, metric, at_least: 3, for_weeks: 8 };
    case "boolean": return { ...base, kind, title: "" };
  }
}

const KIND_NAMES: Record<MilestoneKind, string> = {
  threshold: "Reach a value", cumulative: "Total over time", frequency: "Weekly habit", boolean: "Done / not done",
};

/** Pick what to track by plain name; "Other…" reveals a free-form id for custom metrics. */
function metricPicker(ctx: OutcomesCtx, get: () => string, set: (v: string) => void): Node {
  const ids = [...new Set([...Object.keys(METRICS), ...ctx.summaries.map((s) => s.metric), ...(get() ? [get()] : [])])];
  const OTHER = "__other";
  const sel = h("select", {},
    h("option", { value: "", selected: !get() }, "Choose…"),
    ids.map((id) => h("option", { value: id, selected: id === get() }, metricLabel(id))),
    h("option", { value: OTHER }, "Other…"));
  const custom = h("input", { placeholder: "area.name, e.g. finance.side_income", hidden: true, autocomplete: "off" });
  sel.addEventListener("change", () => {
    custom.hidden = sel.value !== OTHER;
    if (sel.value === OTHER) { set(""); custom.focus(); } else set(sel.value);
  });
  custom.addEventListener("input", () => set(custom.value.trim()));
  return h("label", { class: "metricpick" }, "Track", sel, custom);
}

function checkpointEditor(m: Extract<Milestone, { kind: "threshold" | "cumulative" }>, rerender: () => void): Node {
  const cps = m.checkpoints ?? [];
  const add = () => {
    const last = cps.at(-1);
    (m.checkpoints ??= []).push({ due: last ? addMonths(last.due, 3) : addMonths(todayLocal(), 3), target: NaN });
    rerender();
  };
  return h("div", { class: "cpedit" },
    h("span", { class: "muted" }, cps.length ? "Checkpoints on the way" : ""),
    cps.map((c, j) => h("div", { class: "row" },
      bound("By", () => c.due, (v) => (c.due = v), { type: "date" }),
      bound("Reach", () => (Number.isNaN(c.target) ? "" : c.target), (v) => (c.target = v === "" ? NaN : Number(v)), { inputmode: "decimal" }),
      h("button", { class: "small danger", "aria-label": "Remove checkpoint", onclick: () => {
        cps.splice(j, 1); if (!cps.length) delete m.checkpoints; rerender();
      } }, "×"))),
    h("button", { class: "small", onclick: add }, "Add checkpoint"));
}

export function openEditor(ctx: OutcomesCtx, draft: Outcome, isNew: boolean) {
  const err = errorBox();
  const list = h("div", { class: "mlist" });
  const num = (v: string) => (v === "" ? NaN : Number(v));

  const renderList = () => {
    list.replaceChildren(...draft.milestones.map((m, i) => {
      const replaceKind = (k: MilestoneKind) => { draft.milestones[i] = { ...newMilestone(k, draft, m), id: m.id, due: m.due, title: m.title }; renderList(); };
      const fields: Node[] = [select("Type", KINDS, () => m.kind, replaceKind, KIND_NAMES)];
      const advanced: Node[] = [];
      if (m.kind === "boolean") {
        fields.push(bound("What needs doing", () => m.title, (v) => (m.title = v || undefined)));
      } else {
        fields.push(metricPicker(ctx, () => m.metric, (v) => (m.metric = v)));
        advanced.push(bound("Label (optional)", () => m.title, (v) => (m.title = v || undefined), { placeholder: milestoneLabel({ ...m, title: undefined }) }));
      }
      if (m.kind === "threshold") {
        fields.push(select("Direction", [">=", "<="] as const, () => m.comparator, (v) => (m.comparator = v), { ">=": "at least", "<=": "at most" }));
        fields.push(bound("Target", () => (Number.isNaN(m.target) ? "" : m.target), (v) => (m.target = num(v)), { inputmode: "decimal" }));
        advanced.push(bound("Average over (days)", () => m.smooth, (v) => (m.smooth = optNum(v)), { inputmode: "numeric", placeholder: "1 = latest reading" }));
      }
      if (m.kind === "cumulative") {
        fields.push(bound("Total", () => (Number.isNaN(m.target) ? "" : m.target), (v) => (m.target = num(v)), { inputmode: "decimal" }));
      }
      if (m.kind === "frequency") {
        fields.push(bound("At least / week", () => m.at_least, (v) => (m.at_least = num(v)), { inputmode: "decimal" }));
        fields.push(bound("For weeks", () => m.for_weeks, (v) => (m.for_weeks = num(v)), { inputmode: "numeric" }));
      }
      fields.push(bound("Due", () => m.due, (v) => (m.due = v), { type: "date" }));
      advanced.push(bound("Importance (weight)", () => m.weight, (v) => (m.weight = optNum(v)), { inputmode: "decimal", placeholder: "1 = normal, 2 = counts double" }));
      return h("div", { class: "mrow" },
        h("div", { class: "row between" },
          h("strong", {}, `Milestone ${i + 1}`),
          h("button", { class: "small danger", onclick: () => { draft.milestones.splice(i, 1); renderList(); } }, "Remove")),
        h("div", { class: "row" }, fields),
        m.kind === "threshold" || m.kind === "cumulative" ? checkpointEditor(m, renderList) : null,
        h("details", { class: "advanced" }, h("summary", {}, "More options"), h("div", { class: "row" }, advanced)));
    }));
  };
  renderList();

  const addKind = { k: "threshold" as MilestoneKind };
  const save: HTMLButtonElement = h("button", { class: "primary", onclick: () => guarded(save, err, async () => {
    for (const m of draft.milestones) if (m.title === "") delete m.title;
    const problems = validateOutcome(draft);
    if (problems.length) throw new Error(problems.join("\n"));
    const d = clone(ctx.doc);
    const i = d.outcomes.findIndex((o) => o.id === draft.id);
    if (i >= 0) d.outcomes[i] = draft; else d.outcomes.push(draft);
    save.textContent = "Encrypting & saving…";
    try { await ctx.save(d, isNew ? "outcome: create" : "outcome: edit"); } finally { save.textContent = "Save"; }
  }) }, "Save");

  ctx.mount(h("div", { class: "editor" },
    h("header", {}, h("h1", {}, isNew ? "Review outcome" : "Edit outcome"), h("button", { onclick: () => ctx.back() }, "Cancel")),
    h("section", { class: "card" },
      bound("Outcome", () => draft.title, (v) => (draft.title = v), { placeholder: "What will be true when you're done?" }),
      bound("Why it matters", () => draft.why, (v) => (draft.why = v), { placeholder: "Shown on the dashboard to keep it in view" }),
      h("div", { class: "row" },
        select("Category", CATEGORIES, () => draft.category, (v) => (draft.category = v)),
        bound("Target date", () => draft.horizon, (v) => (draft.horizon = v), { type: "date" })),
      h("details", { class: "advanced" }, h("summary", {}, "More options"),
        h("div", { class: "row" },
          bound("Start date", () => draft.start, (v) => (draft.start = v), { type: "date" }),
          h("p", { class: "muted" }, "Streaks, totals and progress count from here.")))),
    h("section", { class: "card" },
      h("h2", {}, "Milestones"),
      list,
      h("div", { class: "row" },
        select("Add", KINDS, () => addKind.k, (v) => (addKind.k = v), KIND_NAMES),
        h("button", { onclick: () => { draft.milestones.push(newMilestone(addKind.k, draft, draft.milestones.at(-1))); renderList(); } }, "Add milestone"))),
    h("p", { class: "row" }, save, h("button", { onclick: () => ctx.back() }, "Cancel")),
    err,
  ));
}

