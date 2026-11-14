import { addMonths, todayLocal } from "../dates";
import { bound, errorBox, guarded, h, optNum, select } from "../dom";
import { evaluateOutcome, type MilestoneEval, type OutcomeEval, type SeriesIndex, type Status, STATUS_LABEL } from "../engine";
import { metricLabel } from "../metrics";
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
  mount(node: Node): void;                                  // replace the main view
  back(): void;                                             // return to dashboard
}

const SEVERITY: Status[] = ["missed", "off_track", "at_risk", "stale", "no_data", "on_track", "achieved"];
const pill = (s: Status) => h("span", { class: `pill s-${s}` }, STATUS_LABEL[s]);
const bar = (p: number, s: Status) =>
  h("div", { class: "bar", role: "progressbar", "aria-valuenow": Math.round(p * 100), "aria-valuemin": 0, "aria-valuemax": 100 },
    h("span", { class: `s-${s}`, "data-w": Math.round(p * 100) }));

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

  const counts = new Map<Status, number>();
  for (const e of evals) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);

  const section = h("section", { class: "outcomes" },
    h("header", {},
      h("h2", {}, "Outcomes"),
      h("div", { class: "row" },
        ...SEVERITY.filter((s) => counts.get(s)).map((s) => h("span", { class: `pill s-${s}` }, `${counts.get(s)} ${STATUS_LABEL[s]}`)),
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

function milestoneRow(ctx: OutcomesCtx, o: Outcome, e: MilestoneEval, isNext: boolean): Node {
  const m = e.milestone;
  return h("li", { class: isNext ? "next" : "" },
    h("div", { class: "row between" },
      h("span", {}, h("strong", {}, milestoneLabel(m)), h("span", { class: "muted" }, ` · due ${m.due}`)),
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
  );
}

function outcomeCard(ctx: OutcomesCtx, e: OutcomeEval): Node {
  const o = e.outcome;
  return h("article", { class: `card outcome s-border-${e.status}` },
    h("div", { class: "row between" },
      h("div", {}, h("h3", {}, o.title), h("span", { class: "muted" }, `${o.category} · by ${o.horizon}`)),
      pill(e.status)),
    o.why ? h("p", { class: "why" }, o.why) : null,
    h("div", { class: "row between progress" }, bar(e.progress, e.status), h("span", { class: "muted" }, `${Math.round(e.progress * 100)}%`)),
    e.next ? h("div", { class: "nextline" },
      h("span", { class: "muted" }, "Next: "), milestoneLabel(e.next.milestone), h("span", { class: "muted" }, ` (${e.next.milestone.due}) `),
      e.next.hint ? h("div", { class: "hint" }, e.next.hint) : null) : h("p", { class: "ok" }, "All milestones achieved 🎉"),
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
  const latest = ctx.summaries.find((s) => s.metric === t.metric)?.latest.value;
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

  ctx.mount(h("div", {},
    h("header", {}, h("h1", {}, t.label), h("button", { onclick: () => openWizard(ctx) }, "Back")),
    h("section", { class: "card" },
      h("div", { class: "row" },
        bound(t.targetLabel, () => state.target, (v) => (state.target = v), { inputmode: "decimal", id: "tTarget" }),
        bound("By", () => state.horizon, (v) => (state.horizon = v), { type: "date", id: "tHorizon" }),
        t.needsCurrent ? bound(`Where you are today${latest !== undefined ? " (from your data)" : ""}`,
          () => state.current, (v) => (state.current = v), { inputmode: "decimal", id: "tCurrent" }) : null),
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

export function openEditor(ctx: OutcomesCtx, draft: Outcome, isNew: boolean) {
  const err = errorBox();
  const list = h("div", { class: "mlist" });
  const metricsList = h("datalist", { id: "metricNames" }, ctx.summaries.map((s) => h("option", { value: s.metric }, metricLabel(s.metric))));
  const num = (v: string) => (v === "" ? NaN : Number(v));

  const renderList = () => {
    list.replaceChildren(...draft.milestones.map((m, i) => {
      const replaceKind = (k: MilestoneKind) => { draft.milestones[i] = { ...newMilestone(k, draft, m), id: m.id, due: m.due, title: m.title }; renderList(); };
      const fields: Node[] = [select("Type", KINDS, () => m.kind, replaceKind, KIND_NAMES)];
      if (m.kind !== "boolean") {
        fields.push(bound("Metric", () => m.metric, (v) => (m.metric = v), { list: "metricNames", placeholder: "area.name" }));
      }
      if (m.kind === "threshold") {
        fields.push(select("Direction", [">=", "<="] as const, () => m.comparator, (v) => (m.comparator = v), { ">=": "at least", "<=": "at most" }));
        fields.push(bound("Target", () => (Number.isNaN(m.target) ? "" : m.target), (v) => (m.target = num(v)), { inputmode: "decimal" }));
        fields.push(bound("Smooth (days)", () => m.smooth, (v) => (m.smooth = optNum(v)), { inputmode: "numeric", placeholder: "1" }));
      }
      if (m.kind === "cumulative") {
        fields.push(bound("Total", () => (Number.isNaN(m.target) ? "" : m.target), (v) => (m.target = num(v)), { inputmode: "decimal" }));
      }
      if (m.kind === "frequency") {
        fields.push(bound("At least / week", () => m.at_least, (v) => (m.at_least = num(v)), { inputmode: "decimal" }));
        fields.push(bound("For weeks", () => m.for_weeks, (v) => (m.for_weeks = num(v)), { inputmode: "numeric" }));
      }
      fields.push(bound("Due", () => m.due, (v) => (m.due = v), { type: "date" }));
      fields.push(bound("Weight", () => m.weight, (v) => (m.weight = optNum(v)), { inputmode: "decimal", placeholder: "1" }));
      return h("div", { class: "mrow" },
        h("div", { class: "row between" },
          h("strong", {}, `Milestone ${i + 1}`),
          h("button", { class: "small danger", onclick: () => { draft.milestones.splice(i, 1); renderList(); } }, "Remove")),
        bound(m.kind === "boolean" ? "What needs doing" : "Label (optional)", () => m.title, (v) => (m.title = v || undefined)),
        h("div", { class: "row" }, fields));
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
    metricsList,
    h("section", { class: "card" },
      bound("Outcome", () => draft.title, (v) => (draft.title = v), { placeholder: "What will be true when you're done?" }),
      bound("Why it matters", () => draft.why, (v) => (draft.why = v), { placeholder: "Shown on the dashboard to keep it in view" }),
      h("div", { class: "row" },
        select("Category", CATEGORIES, () => draft.category, (v) => (draft.category = v)),
        bound("Start", () => draft.start, (v) => (draft.start = v), { type: "date" }),
        bound("Target date", () => draft.horizon, (v) => (draft.horizon = v), { type: "date" }))),
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

