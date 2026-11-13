// Tiny safe DOM helper: text only, never innerHTML, so decrypted data can't inject markup.
export type Child = Node | string | null | undefined | false;
type Attr = string | number | boolean | undefined | ((e: Event) => void);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

export const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
export const errorBox = () => h("p", { class: "error", role: "alert" });

export async function guarded(btn: HTMLButtonElement, err: HTMLElement, fn: () => Promise<void>) {
  btn.disabled = true;
  err.textContent = "";
  try { await fn(); } catch (e) { err.textContent = (e as Error).message; } finally { btn.disabled = false; }
}

/** An input bound to a getter/setter; `parse` returning undefined clears the value. */
export function bound(
  label: string,
  get: () => string | number | undefined,
  set: (v: string) => void,
  attrs: Record<string, Attr> = {},
): HTMLLabelElement {
  const input = h("input", { ...attrs, value: get() ?? "" });
  input.addEventListener("input", () => set(input.value.trim()));
  return h("label", {}, label, input);
}

export function select<T extends string>(label: string, options: readonly T[], get: () => T, set: (v: T) => void, names?: Partial<Record<T, string>>) {
  const s = h("select", {}, ...options.map((o) => h("option", { value: o, selected: o === get() }, names?.[o] ?? o)));
  s.addEventListener("change", () => set(s.value as T));
  return h("label", {}, label, s);
}

export const optNum = (v: string): number | undefined => (v === "" ? undefined : Number(v));
