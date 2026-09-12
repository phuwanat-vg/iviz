/**
 * The Parameters tab: try values on the running robot.
 *
 * Parameters are read and written through the bridge's own parameter support,
 * which sets them on the live nodes and writes nothing to any file. A restart
 * of the node brings its old values back, so the tab keeps a list of every
 * value changed in this session, with what it was before, and can put it all
 * back or hand it over as `ros2 param set` lines.
 */

import type { Parameter } from "@foxglove/ws-protocol";
import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import { h, row } from "./dom";
import { icon } from "./icons";

export interface ParamPanelHost {
  conn: FoxgloveConnection;
  toast(message: string, kind?: "error" | "info"): void;
}

interface Change {
  name: string;
  before: unknown;
  after: unknown;
  at: number;
}

/** `/controller_server.FollowPath.max_vel_x` → node and the rest. */
function splitName(name: string): { node: string; rest: string } {
  const dot = name.indexOf(".");
  if (dot < 0) return { node: name, rest: name };
  return { node: name.slice(0, dot), rest: name.slice(dot + 1) };
}

export class ParamPanel {
  readonly element: HTMLElement;

  #host: ParamPanelHost;
  #search: HTMLInputElement;
  #loadBtn: HTMLButtonElement;
  #note: HTMLElement;
  #list: HTMLElement;
  #changesBox: HTMLElement;
  #changesSummary: HTMLElement;
  #changesList: HTMLElement;
  #cli!: HTMLElement;
  #values = new Map<string, unknown>();
  #changes = new Map<string, Change>();
  #openNodes = new Set<string>();
  #loading = false;
  #listKey = "";
  #supportsSeen = false;
  #disposers: (() => void)[] = [];

  constructor(host: ParamPanelHost) {
    this.#host = host;
    this.#search = h("input", { type: "text", placeholder: "Search by node or parameter" });
    this.#search.addEventListener("input", () => this.#renderList(true));
    this.#loadBtn = h("button", { class: "primary" }, icon("refresh"), "Load parameters");
    this.#loadBtn.addEventListener("click", () => void this.#load());
    this.#note = h("div", { class: "nav-note" });
    this.#list = h("div", { class: "param-list" });
    this.#changesSummary = h("summary", { text: "Changed parameters" });
    this.#changesList = h("div", { class: "param-changes" });
    const revertAll = h("button", {}, icon("undo"), "Put them all back");
    revertAll.addEventListener("click", () => void this.#revertAll());
    const copy = h("button", {}, icon("copy"), "Copy as ros2 param set");
    copy.addEventListener("click", () => void this.#copyChanges());
    this.#cli = h("pre", { class: "nav-cmd" });
    this.#changesBox = h(
      "details",
      { class: "param-changed" },
      this.#changesSummary,
      this.#changesList,
      this.#cli,
      h("div", { class: "nav-buttons" }, revertAll, copy),
      h("div", { class: "nav-note", text: "Values live in the running nodes only. Nothing here is written to a file on the robot." }),
    );

    this.element = h(
      "div",
      { class: "param-panel" },
      h("div", { class: "nav-buttons" }, this.#loadBtn),
      h("div", { class: "row" }, this.#search),
      this.#note,
      this.#changesBox,
      this.#list,
    );

    this.#disposers.push(host.conn.onStateChange((state) => this.#onState(state)));
    this.#disposers.push(host.conn.onParameterUpdate((parameters) => this.#onUpdate(parameters)));
    // What the bridge can do arrives just after it says it is connected, so
    // the panel waits for that before deciding it has no parameters.
    this.#disposers.push(
      host.conn.onChannelsChange(() => {
        const supported = host.conn.supportsParameters;
        if (supported === this.#supportsSeen) return;
        this.#supportsSeen = supported;
        this.#render();
        if (supported && !this.element.hidden) void this.#load();
      }),
    );
    this.#render();
  }

  /** Called when the tab is shown; loads once per connection. */
  refresh(): void {
    if (this.#values.size === 0 && !this.#loading && this.#host.conn.state === "connected" && this.#host.conn.supportsParameters) {
      void this.#load();
      return;
    }
    this.#render();
  }

  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }

  // ----- data --------------------------------------------------------------

  #onState(state: string): void {
    if (state === "disconnected") {
      this.#values.clear();
      this.#listKey = "";
      this.#supportsSeen = false;
      // Changes stay listed: they say what was touched on the robot.
    }
    this.#render();
  }

  #onUpdate(parameters: Parameter[]): void {
    for (const p of parameters) this.#values.set(p.name, p.value);
    this.#listKey = "";
    this.#render();
  }

  async #load(): Promise<void> {
    const conn = this.#host.conn;
    if (this.#loading) return;
    this.#loading = true;
    this.#render();
    try {
      const parameters = await conn.getParameters();
      this.#values.clear();
      for (const p of parameters) this.#values.set(p.name, p.value);
      conn.subscribeParameterUpdates();
      this.#listKey = "";
      this.#host.toast(`Read ${parameters.length} parameters`, "info");
    } catch (err) {
      this.#host.toast(message(err));
    } finally {
      this.#loading = false;
      this.#render();
    }
  }

  async #apply(name: string, value: unknown, input: HTMLElement): Promise<void> {
    const before = this.#values.get(name);
    input.classList.remove("failed", "changed");
    try {
      const result = await this.#host.conn.setParameters([{ name, value } as Parameter]);
      const applied = result.find((p) => p.name === name)?.value ?? value;
      this.#values.set(name, applied);
      if (JSON.stringify(applied) !== JSON.stringify(value)) {
        input.classList.add("failed");
        this.#host.toast(`${name} kept ${format(applied)}; the node did not take ${format(value)}`);
      } else {
        input.classList.add("changed");
        this.#host.toast(`${name} = ${format(applied)}`, "info");
      }
      this.#recordChange(name, before, applied);
    } catch (err) {
      input.classList.add("failed");
      this.#host.toast(message(err));
    }
    this.#renderChanges();
  }

  #recordChange(name: string, before: unknown, after: unknown): void {
    const first = this.#changes.get(name);
    const original = first ? first.before : before;
    if (JSON.stringify(original) === JSON.stringify(after)) this.#changes.delete(name);
    else this.#changes.set(name, { name, before: original, after, at: Date.now() });
  }

  async #revert(name: string): Promise<void> {
    const change = this.#changes.get(name);
    if (!change) return;
    try {
      await this.#host.conn.setParameters([{ name, value: change.before } as Parameter]);
      this.#values.set(name, change.before);
      this.#changes.delete(name);
      this.#listKey = "";
      this.#host.toast(`${name} back to ${format(change.before)}`, "info");
    } catch (err) {
      this.#host.toast(message(err));
    }
    this.#render();
  }

  async #revertAll(): Promise<void> {
    const changes = [...this.#changes.values()];
    if (changes.length === 0) return;
    try {
      await this.#host.conn.setParameters(changes.map((c) => ({ name: c.name, value: c.before }) as Parameter));
      for (const c of changes) this.#values.set(c.name, c.before);
      this.#changes.clear();
      this.#listKey = "";
      this.#host.toast(`Put ${changes.length} parameter${changes.length === 1 ? "" : "s"} back`, "info");
    } catch (err) {
      this.#host.toast(message(err));
    }
    this.#render();
  }

  /** The changes as commands, to keep them after a restart. */
  #cliLines(): string[] {
    return [...this.#changes.values()].map((c) => {
      const { node, rest } = splitName(c.name);
      return `ros2 param set ${node} ${rest} ${format(c.after)}`;
    });
  }

  async #copyChanges(): Promise<void> {
    const lines = this.#cliLines();
    if (lines.length === 0) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      this.#host.toast(`Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`, "info");
    } catch {
      this.#host.toast("The clipboard is not available; select the lines below instead");
    }
  }

  // ----- rendering ---------------------------------------------------------

  #render(): void {
    const conn = this.#host.conn;
    this.#loadBtn.disabled = this.#loading || conn.state !== "connected" || !conn.supportsParameters;
    this.#loadBtn.replaceChildren(icon("refresh"), this.#loading ? "Reading…" : this.#values.size > 0 ? "Read again" : "Load parameters");
    if (conn.state !== "connected") setNote(this.#note, "Connect to a robot to see its parameters.", false);
    else if (!conn.supportsParameters) setNote(this.#note, "This bridge does not offer parameters.", true);
    else if (this.#values.size === 0) setNote(this.#note, this.#loading ? "" : "Press Load parameters.", false);
    else setNote(this.#note, `${this.#values.size} parameters. Values apply to the running node at once; nothing is saved to a file.`, false);
    this.#renderChanges();
    this.#renderList(false);
  }

  #renderChanges(): void {
    const changes = [...this.#changes.values()].sort((a, b) => b.at - a.at);
    this.#changesSummary.textContent = changes.length === 0 ? "Changed parameters" : `Changed parameters (${changes.length})`;
    this.#changesBox.hidden = changes.length === 0;
    this.#cli.textContent = this.#cliLines().join("\n");
    this.#cli.hidden = changes.length === 0;
    this.#changesList.replaceChildren(
      ...changes.map((change) => {
        const revert = h("button", { class: "icon-only", title: "Put this one back" }, icon("undo"));
        revert.addEventListener("click", () => void this.#revert(change.name));
        return h(
          "div",
          { class: "param-change", title: change.name },
          h("span", { class: "name", text: change.name }),
          h("span", { class: "was", text: format(change.before) }),
          h("span", { class: "arrow", text: "→" }),
          h("span", { class: "now", text: format(change.after) }),
          revert,
        );
      }),
    );
  }

  #renderList(force: boolean): void {
    const query = this.#search.value.trim().toLowerCase();
    const names = [...this.#values.keys()].filter((n) => query === "" || n.toLowerCase().includes(query)).sort();
    const key = `${this.#host.conn.state}|${query}|${names.length}|${[...this.#openNodes].join(",")}|${JSON.stringify([...this.#values.values()]).length}`;
    if (!force && key === this.#listKey) return;
    this.#listKey = key;

    const byNode = new Map<string, string[]>();
    for (const name of names) {
      const { node } = splitName(name);
      const list = byNode.get(node) ?? [];
      list.push(name);
      byNode.set(node, list);
    }
    // With a search on, open what matched; otherwise leave the groups closed.
    const groups = [...byNode.entries()].map(([node, params]) => {
      const box = h("details", { class: "param-node" });
      box.open = query !== "" || this.#openNodes.has(node);
      box.addEventListener("toggle", () => {
        if (box.open) this.#openNodes.add(node);
        else this.#openNodes.delete(node);
      });
      box.append(
        h("summary", {}, h("span", { class: "name", text: node }), h("span", { class: "count", text: String(params.length) })),
        ...params.map((name) => this.#paramRow(name)),
      );
      return box;
    });
    this.#list.replaceChildren(...(groups.length > 0 ? groups : this.#values.size > 0 ? [h("div", { class: "empty", text: "Nothing matches" })] : []));
  }

  #paramRow(name: string): HTMLElement {
    const value = this.#values.get(name);
    const { rest } = splitName(name);
    const changed = this.#changes.has(name);

    if (typeof value === "boolean") {
      const input = h("input", { type: "checkbox" });
      input.checked = value;
      input.addEventListener("change", () => void this.#apply(name, input.checked, input));
      return row(rest, input, ...(changed ? [changedMark()] : []));
    }

    const isNumber = typeof value === "number";
    const input = h("input", {
      type: isNumber ? "number" : "text",
      value: isNumber || typeof value === "string" ? String(value) : JSON.stringify(value ?? null),
      title: name,
    });
    if (isNumber) input.step = "any";
    const commit = (): void => {
      const text = input.value.trim();
      let next: unknown;
      if (isNumber) {
        next = Number(text);
        if (!Number.isFinite(next as number)) {
          input.classList.add("failed");
          return;
        }
      } else if (typeof value === "string") {
        next = text;
      } else {
        try {
          next = JSON.parse(text === "" ? "null" : text);
        } catch {
          input.classList.add("failed");
          this.#host.toast(`${name}: that is not valid JSON`);
          return;
        }
      }
      if (JSON.stringify(next) === JSON.stringify(this.#values.get(name))) return;
      void this.#apply(name, next, input);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });
    return row(rest, input, ...(changed ? [changedMark()] : []));
  }
}

function changedMark(): HTMLElement {
  return h("span", { class: "ask-mark", text: "set", title: "Changed in this session" });
}

function setNote(el: HTMLElement, text: string, warn: boolean): void {
  el.textContent = text;
  el.hidden = text === "";
  el.classList.toggle("warn", warn);
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value ?? null);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
