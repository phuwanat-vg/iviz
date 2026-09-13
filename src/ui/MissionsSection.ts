/**
 * The Missions section at the top of the Dashboard: what the robot is running,
 * the missions it has, and how recent runs ended.
 *
 * Everything goes through mission_runner's `/mission/api` tunnel on the bridge
 * connection iViz already has, so the robot needs nothing besides
 * mission_runner and mission_msgs. Live state comes from `/mission/state` and
 * `/mission/event`; while neither has said anything for a few seconds and the
 * tab is on screen, `/api/status` is polled every 2 s instead.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import { MissionApiError } from "../mission/MissionApi";
import type { MissionApi, MissionSummary, Run, RunDetail, RunnerEvent, RunnerStatus } from "../mission/MissionApi";
import type { InputDef, Mission, Path } from "../mission/types";
import type { AppSettings } from "../state/settings";
import { h } from "./dom";
import { icon } from "./icons";

export interface MissionsHost {
  conn: FoxgloveConnection;
  settings: AppSettings;
  missionApi: MissionApi;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
}

const POLL_MS = 2000;
/** Live state counts as flowing when something arrived this recently. */
const LIVE_FRESH_MS = 5000;
const HISTORY_LIMIT = 10;
/** Past this many missions a search box appears. */
const SEARCH_FROM = 7;

/** A Run button that was pressed and needs inputs or a confirmation first. */
interface RunForm {
  name: string;
  doc: Mission | null;
  values: Record<string, string | boolean>;
  error: string;
}

interface TimelineStep {
  id: string;
  name: string;
  type: string;
  /** 0 for the top of the flow, 1 inside a loop or branch, and so on. */
  depth: number;
  /** A pause or resume of the whole run rather than a step. */
  marker?: boolean;
  start: number;
  end?: number;
  status?: string;
  error?: string;
}

export class MissionsSection {
  readonly element: HTMLElement;

  #host: MissionsHost;
  #status: RunnerStatus | null = null;
  #liveAt = 0;
  #missions: MissionSummary[] | null = null;
  #missionsAt = 0;
  #missionsError = "";
  #runs: Run[] | null = null;
  #runsError = "";
  #docs = new Map<string, Mission>();
  #details = new Map<string, RunDetail | string>();
  #openRun = "";
  #form: RunForm | null = null;
  #stopping = false;
  #busy = "";
  #search = "";
  #siteNames: string[] = [];

  #noteEl: HTMLElement;
  #bodyEl: HTMLElement;
  #currentEl: HTMLElement;
  #listHead: HTMLElement;
  #searchInput: HTMLInputElement;
  #listEl: HTMLElement;
  #historyHead: HTMLElement;
  #historyEl: HTMLElement;
  #elapsedEl: HTMLElement | null = null;
  #disposers: (() => void)[] = [];
  #timer?: ReturnType<typeof setInterval>;
  #clock?: ReturnType<typeof setInterval>;
  #runsReload?: ReturnType<typeof setTimeout>;

  constructor(host: MissionsHost) {
    this.#host = host;
    this.#noteEl = h("div", { class: "nav-note" });
    this.#currentEl = h("div", { class: "mission-current" });
    this.#listEl = h("div", { class: "mission-list" });
    this.#historyEl = h("div", { class: "run-list" });
    this.#searchInput = h("input", { type: "text", class: "mission-search", placeholder: "Search missions" });
    this.#searchInput.addEventListener("input", () => {
      this.#search = this.#searchInput.value.trim().toLowerCase();
      this.#renderList();
    });

    const refresh = h("button", { class: "icon-only", title: "Load the missions and recent runs again" }, icon("refresh"));
    refresh.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#docs.clear();
      void this.#loadMissions();
      void this.#loadRuns();
      void this.#pollStatus();
    });
    this.#listHead = this.#foldHead("Missions on the robot", "list", () => host.settings.missions.listOpen, (open) => (host.settings.missions.listOpen = open), refresh);
    this.#historyHead = this.#foldHead("Recent runs", "clock", () => host.settings.missions.historyOpen, (open) => (host.settings.missions.historyOpen = open));

    this.#bodyEl = h("div", {}, this.#currentEl, this.#listHead, this.#searchInput, this.#listEl, this.#historyHead, this.#historyEl);
    this.element = h("div", { class: "missions" }, h("div", { class: "nav-sub" }, icon("flag"), "Missions"), this.#noteEl, this.#bodyEl);

    host.missionApi.startLiveState();
    this.#disposers.push(host.missionApi.onStatus((status) => this.#applyStatus(status, true)));
    this.#disposers.push(host.missionApi.onEvent((event) => this.#onEvent(event)));
    this.#disposers.push(host.missionApi.onAvailabilityChange((available) => this.#onAvailability(available)));
    this.#disposers.push(host.conn.onStateChange(() => this.#render()));
    const onVisibility = () => {
      if (document.visibilityState === "visible") this.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.#disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

    this.#timer = setInterval(() => this.#tick(), POLL_MS);
    // Only the elapsed time changes every second; the card is left alone.
    this.#clock = setInterval(() => this.#renderElapsed(), 1000);
    if (host.missionApi.lastStatus) this.#applyStatus(host.missionApi.lastStatus, false);
    this.#onAvailability(host.missionApi.available);
  }

  /** The Dashboard tab was opened: bring the list and history up to date. */
  refresh(): void {
    if (!this.#host.missionApi.available) {
      this.#render();
      return;
    }
    if (Date.now() - this.#missionsAt > 10_000) void this.#loadMissions();
    void this.#loadRuns();
    if (Date.now() - this.#liveAt > LIVE_FRESH_MS) void this.#pollStatus();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#clock) clearInterval(this.#clock);
    if (this.#runsReload) clearTimeout(this.#runsReload);
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }

  // ----- data --------------------------------------------------------------

  #onAvailability(available: boolean): void {
    if (!available) {
      this.#status = null;
      this.#missions = null;
      this.#runs = null;
      this.#docs.clear();
      this.#details.clear();
      this.#form = null;
      this.#stopping = false;
      this.#render();
      return;
    }
    this.#render();
    void this.#pollStatus();
    void this.#loadMissions();
    void this.#loadRuns();
  }

  #visible(): boolean {
    return document.visibilityState === "visible" && this.element.isConnected && this.element.offsetParent !== null;
  }

  #tick(): void {
    if (!this.#host.missionApi.available || !this.#visible()) return;
    if (Date.now() - this.#liveAt > LIVE_FRESH_MS) void this.#pollStatus();
    if (this.#missions === null && this.#missionsError === "") void this.#loadMissions();
  }

  async #pollStatus(): Promise<void> {
    if (!this.#host.missionApi.available) return;
    try {
      this.#applyStatus(await this.#host.missionApi.status(), false);
    } catch {
      /* the next tick tries again; the list shows the error if the runner is gone */
    }
  }

  async #loadMissions(): Promise<void> {
    if (!this.#host.missionApi.available) return;
    this.#missionsAt = Date.now();
    try {
      // The global mission holds interrupts only and cannot be run.
      this.#missions = (await this.#host.missionApi.missions()).filter((m) => m.name !== "global");
      this.#missionsError = "";
    } catch (err) {
      this.#missionsError = message(err);
    }
    this.#renderList();
  }

  async #loadRuns(): Promise<void> {
    if (!this.#host.missionApi.available) return;
    try {
      this.#runs = await this.#host.missionApi.runs(HISTORY_LIMIT);
      this.#runsError = "";
      // Steps of a run that was still going when it was opened are out of date now.
      for (const run of this.#runs) {
        const detail = this.#details.get(run.id);
        if (detail !== undefined && (typeof detail === "string" || detail.status !== run.status)) this.#details.delete(run.id);
        if (this.#openRun === run.id && !this.#details.has(run.id)) void this.#fetchDetail(run.id);
      }
    } catch (err) {
      this.#runsError = message(err);
    }
    this.#renderHistory();
  }

  /** Several run events arrive together; load the history once for them. */
  #scheduleRuns(): void {
    if (this.#runsReload) clearTimeout(this.#runsReload);
    this.#runsReload = setTimeout(() => void this.#loadRuns(), 600);
  }

  async #doc(name: string): Promise<Mission | null> {
    const cached = this.#docs.get(name);
    if (cached) return cached;
    try {
      const doc = await this.#host.missionApi.mission(name);
      this.#docs.set(name, doc);
      return doc;
    } catch {
      return null;
    }
  }

  #applyStatus(status: RunnerStatus, live: boolean): void {
    const before = this.#status;
    this.#status = status;
    if (live) this.#liveAt = Date.now();
    const run = status.run;
    if (run && !this.#docs.has(run.mission)) {
      void this.#doc(run.mission).then(() => this.#renderCurrent());
    }
    if (!run) this.#stopping = false;
    // A run that started or ended while nobody was listening still reaches the history.
    if ((before?.run?.id ?? "") !== (run?.id ?? "") || (before?.run?.status ?? "") !== (run?.status ?? "")) this.#scheduleRuns();
    this.#renderCurrent();
    if ((before?.run?.mission ?? "") !== (run?.mission ?? "") || queueKey(before) !== queueKey(status)) this.#renderList();
  }

  #onEvent(event: RunnerEvent): void {
    this.#liveAt = Date.now();
    const status = this.#status;
    switch (event.type) {
      case "run.started":
        if (event.run) this.#host.toast(`Mission started: ${this.#title(event.run.mission)}`, "info");
        this.#scheduleRuns();
        return;
      case "run.finished": {
        const run = event.run;
        if (run) {
          const title = this.#title(run.mission);
          if (run.status === "failed") this.#host.toast(`${title} failed${run.error ? `: ${run.error}` : ""}`);
          else if (run.status === "succeeded") this.#host.toast(`${title} succeeded`, "info");
          else if (run.status === "canceled" && run.started_at) this.#host.toast(`${title} canceled${run.error ? `: ${run.error}` : ""}`, "info");
          if (status?.run?.id === run.id) status.run = { ...status.run, ...run };
        }
        this.#scheduleRuns();
        this.#renderCurrent();
        return;
      }
      case "run.queued":
      case "run.suspended":
      case "run.paused":
      case "run.resumed":
        this.#scheduleRuns();
        return;
      case "step.started":
        if (status?.run && status.run.id === event.run_id && event.step_id) {
          status.run = { ...status.run, step: { id: event.step_id, name: event.name, type: event.step_type, path: event.path } };
          this.#renderCurrent();
        }
        return;
      case "feedback":
        if (status?.run && status.run.id === event.run_id && event.feedback) {
          status.run = { ...status.run, feedback: event.feedback };
          this.#renderCurrent();
        }
        return;
      case "missions.changed":
        this.#docs.clear();
        void this.#loadMissions();
        return;
    }
  }

  // ----- actions -----------------------------------------------------------

  async #pressRun(mission: MissionSummary): Promise<void> {
    if (this.#busy) return;
    this.#busy = mission.name;
    this.#renderList();
    const doc = await this.#doc(mission.name);
    this.#busy = "";
    const inputs = Object.entries(doc?.inputs ?? {});
    if (inputs.length > 0 || this.#preemptNote(doc) !== "") {
      const values: Record<string, string | boolean> = {};
      for (const [key, def] of inputs) values[key] = initialValue(def);
      this.#form = { name: mission.name, doc, values, error: "" };
      if (inputs.some(([, def]) => def.type === "site")) void this.#loadSiteNames();
      this.#renderList();
      return;
    }
    await this.#submit(mission.name, undefined);
  }

  async #submitForm(): Promise<void> {
    const form = this.#form;
    if (!form) return;
    const inputs: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(form.doc?.inputs ?? {})) {
      const raw = form.values[key];
      const label = def.label || key;
      if (def.type === "boolean") {
        inputs[key] = raw === true;
        continue;
      }
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "") {
        if (def.required && def.default === undefined) {
          form.error = `${label} is required.`;
          this.#renderList();
          return;
        }
        continue;
      }
      if (def.type === "number") {
        const n = Number(text);
        if (!Number.isFinite(n)) {
          form.error = `${label} must be a number.`;
          this.#renderList();
          return;
        }
        inputs[key] = n;
      } else if (def.type === "json" || def.type === "pose") {
        try {
          inputs[key] = JSON.parse(text);
        } catch {
          // A pose may be a site name, which is not JSON.
          if (def.type === "pose") inputs[key] = text;
          else {
            form.error = `${label} is not valid JSON.`;
            this.#renderList();
            return;
          }
        }
      } else {
        inputs[key] = text;
      }
    }
    await this.#submit(form.name, Object.keys(inputs).length > 0 ? inputs : undefined);
  }

  async #submit(name: string, inputs: Record<string, unknown> | undefined): Promise<void> {
    const title = this.#title(name);
    this.#busy = name;
    this.#renderList();
    try {
      const accepted = await this.#host.missionApi.run(name, inputs);
      if (accepted.accepted === false) throw new Error(accepted.reason || "refused");
      const reason = accepted.reason ?? "";
      this.#host.toast(reason === "starting" || reason === "" ? `Starting ${title}` : `${title}: ${reason}`, "info");
      this.#form = null;
    } catch (err) {
      const text = message(err);
      if (this.#form?.name === name) this.#form.error = `Not started: ${text}`;
      this.#host.toast(`${title} was not started: ${text === "busy" ? "the robot is busy and this mission does not wait" : text}`);
    } finally {
      this.#busy = "";
      this.#renderList();
      void this.#pollStatus();
      this.#scheduleRuns();
    }
  }

  async #control(kind: "pause" | "resume" | "cancel" | "stop"): Promise<void> {
    const run = this.#status?.run;
    if (this.#busy || (!run && kind !== "stop")) return;
    const api = this.#host.missionApi;
    this.#busy = kind;
    this.#renderCurrent();
    try {
      if (kind === "pause") await api.pause(run!.id);
      else if (kind === "resume") await api.resume(run!.id);
      else if (kind === "cancel") await api.cancel(run!.id);
      else await api.stop();
      this.#stopping = false;
    } catch (err) {
      this.#host.toast(`Could not ${kind === "stop" ? "stop everything" : kind} the run: ${message(err)}`);
    } finally {
      this.#busy = "";
      await this.#pollStatus();
      this.#renderCurrent();
    }
  }

  async #toggleRun(id: string): Promise<void> {
    this.#openRun = this.#openRun === id ? "" : id;
    this.#renderHistory();
    if (this.#openRun === "" || this.#details.has(id)) return;
    await this.#fetchDetail(id);
  }

  async #fetchDetail(id: string): Promise<void> {
    try {
      this.#details.set(id, await this.#host.missionApi.runDetail(id));
    } catch (err) {
      this.#details.set(id, message(err));
    }
    this.#renderHistory();
  }

  async #loadSiteNames(): Promise<void> {
    if (this.#siteNames.length > 0) return;
    try {
      const doc = await this.#host.missionApi.sites();
      const names = new Set<string>();
      for (const map of Object.values(doc.maps ?? {})) {
        const sites = (map as { sites?: unknown }).sites;
        if (sites && typeof sites === "object") for (const key of Object.keys(sites)) names.add(key);
      }
      this.#siteNames = [...names].sort();
      this.#renderList();
    } catch {
      /* free text still works */
    }
  }

  // ----- rendering ---------------------------------------------------------

  #render(): void {
    const { conn, missionApi } = this.#host;
    let note = "";
    let warn = false;
    if (conn.state !== "connected") {
      note = "Not connected. Connect to the robot's bridge to see its missions.";
    } else if (!missionApi.available) {
      warn = true;
      note = `mission_runner was not found. Missions need mission_runner and mission_msgs on the robot, reachable through foxglove_bridge. ${missionApi.unavailableReason}`;
    }
    this.#noteEl.textContent = note;
    this.#noteEl.hidden = note === "";
    this.#noteEl.classList.toggle("warn", warn);
    this.#bodyEl.hidden = note !== "";
    this.#renderCurrent();
    this.#renderList();
    this.#renderHistory();
  }

  #foldHead(title: string, iconName: "list" | "clock", isOpen: () => boolean, setOpen: (open: boolean) => void, ...extra: HTMLElement[]): HTMLElement {
    const caret = h("span", { class: "caret" });
    const head = h("div", { class: "nav-sub fold", title: "Show or hide" }, caret, icon(iconName), h("span", { text: title }), ...extra);
    const sync = () => {
      caret.textContent = isOpen() ? "▾" : "▸";
    };
    head.addEventListener("click", () => {
      setOpen(!isOpen());
      this.#host.persist();
      sync();
      this.#renderList();
      this.#renderHistory();
      if (isOpen()) this.refresh();
    });
    sync();
    return head;
  }

  #title(name: string): string {
    const summary = this.#missions?.find((m) => m.name === name);
    return summary?.title || this.#docs.get(name)?.title || name;
  }

  /** What starting this mission would do to the active run, or "" when nothing. */
  #preemptNote(doc: Mission | null): string {
    const run = this.#status?.run;
    if (!doc || !run || (run.status !== "running" && run.status !== "paused")) return "";
    const policy = doc.policy ?? "queue";
    const priority = doc.priority ?? 50;
    const current = this.#title(run.mission);
    if (priority < (run.priority ?? 50)) return "";
    if (policy === "preempt" || policy === "preempt_latest") return `Starting ${this.#title(doc.name)} cancels ${current}, which is ${run.status}.`;
    if (policy === "interrupt_and_resume") return `Starting ${this.#title(doc.name)} interrupts ${current}; it resumes afterwards.`;
    return "";
  }

  #renderCurrent(): void {
    const status = this.#status;
    const run = status?.run ?? null;
    const queue = status?.queue ?? [];
    const suspended = status?.suspended ?? [];
    this.#elapsedEl = null;
    if (!run) {
      const parts: HTMLElement[] = [h("div", { class: "empty", text: status ? "Nothing is running" : "Waiting for the runner's state…" })];
      if (queue.length > 0 || suspended.length > 0) parts.push(this.#queueLine(queue, suspended));
      this.#currentEl.replaceChildren(...parts);
      return;
    }

    const paused = run.status === "paused";
    const doc = this.#docs.get(run.mission);
    this.#elapsedEl = h("span", { class: "elapsed" });
    const head = h("div", { class: "head" }, chip(run.status), h("span", { class: "title", text: this.#title(run.mission), title: run.mission }), this.#elapsedEl);
    const parts: HTMLElement[] = [head];

    const step = run.step;
    const flow = doc?.flow ?? [];
    const index = step ? topIndex(step.path, step.id, flow) : -1;
    if (step) {
      // An unnamed step reports its type as its name.
      const where = index >= 0 && flow.length > 0 ? ` · step ${index + 1} of ${flow.length}` : "";
      parts.push(h("div", { class: "detail" }, h("span", { class: "label", text: "Step " }), h("span", { class: "step", text: stepLabel(step.id, step.name, step.type) }), where));
    } else {
      parts.push(h("div", { class: "detail", text: paused ? "Paused; the step re-runs on resume" : "Between steps" }));
    }
    if (index >= 0 && flow.length > 0) {
      const bar = h("div", { class: "mission-progress" }, h("span", { style: `width: ${Math.round(((index + (step ? 0.5 : 1)) / flow.length) * 100)}%` }));
      parts.push(bar);
    }
    // Navigation is canceled while paused, so its last feedback is stale.
    const fb = paused ? null : run.feedback;
    if (fb) {
      const bits: string[] = [];
      if (typeof fb.distance_remaining === "number") bits.push(`${fb.distance_remaining.toFixed(1)} m to go`);
      if (typeof fb.eta_s === "number") bits.push(`ETA ${formatDuration(fb.eta_s)}`);
      if (fb.recoveries) bits.push(`${fb.recoveries} ${fb.recoveries === 1 ? "recovery" : "recoveries"}`);
      if (bits.length > 0) parts.push(h("div", { class: "detail", text: bits.join(" · ") }));
    }
    const source = run.source;
    if (source && source.kind !== "manual") parts.push(h("div", { class: "detail", text: `Started by ${source.kind}${source.detail ? `: ${source.detail}` : source.id ? ` ${source.id}` : ""}` }));
    if (status?.prompt) parts.push(h("div", { class: "detail warn", text: "Waiting for an answer below" }));

    const busy = this.#busy !== "";
    if (this.#stopping) {
      const others = queue.length + suspended.length;
      const cancel = h("button", { class: "danger" }, icon("stop"), "Stop this run");
      cancel.disabled = busy;
      cancel.addEventListener("click", () => void this.#control("cancel"));
      const buttons: HTMLElement[] = [cancel];
      if (others > 0) {
        const all = h("button", { class: "danger", title: "Cancel the active run, the queue and suspended runs" }, icon("octagon"), `Stop all (${others} waiting)`);
        all.disabled = busy;
        all.addEventListener("click", () => void this.#control("stop"));
        buttons.push(all);
      }
      const keep = h("button", {}, "Keep running");
      keep.addEventListener("click", () => {
        this.#stopping = false;
        this.#renderCurrent();
      });
      buttons.push(keep);
      parts.push(h("div", { class: "confirm", text: `Stop ${this.#title(run.mission)}? The robot stops where it is.` }), h("div", { class: "nav-buttons" }, ...buttons));
    } else {
      const toggle = h("button", {}, icon(paused ? "play" : "pause"), this.#busy === "pause" || this.#busy === "resume" ? `${paused ? "Resuming" : "Pausing"}…` : paused ? "Resume" : "Pause");
      toggle.disabled = busy || (run.status !== "running" && run.status !== "paused");
      toggle.addEventListener("click", () => void this.#control(paused ? "resume" : "pause"));
      const stop = h("button", { class: "danger" }, icon("stop"), "Stop");
      stop.disabled = busy;
      stop.addEventListener("click", () => {
        this.#stopping = true;
        this.#renderCurrent();
      });
      parts.push(h("div", { class: "nav-buttons" }, toggle, stop));
    }
    if (queue.length > 0 || suspended.length > 0) parts.push(this.#queueLine(queue, suspended));

    this.#currentEl.replaceChildren(h("div", { class: `mission-run ${run.status}` }, ...parts));
    this.#renderElapsed();
  }

  #queueLine(queue: Run[], suspended: Run[]): HTMLElement {
    const bits: string[] = [];
    if (queue.length > 0) bits.push(`${queue.length} queued: ${queue.map((r) => this.#title(r.mission)).join(", ")}`);
    if (suspended.length > 0) bits.push(`${suspended.length} suspended: ${suspended.map((r) => this.#title(r.mission)).join(", ")}`);
    return h("div", { class: "nav-note", text: bits.join(" · ") });
  }

  #renderElapsed(): void {
    const run = this.#status?.run;
    if (!this.#elapsedEl || !run?.started_at) return;
    const started = Date.parse(run.started_at);
    if (Number.isNaN(started)) return;
    this.#elapsedEl.textContent = formatDuration((Date.now() - started) / 1000);
  }

  #renderList(): void {
    const open = this.#host.settings.missions.listOpen;
    const missions = this.#missions;
    this.#searchInput.hidden = !open || !missions || missions.length < SEARCH_FROM;
    if (!open) {
      this.#listEl.replaceChildren();
      return;
    }
    if (this.#missionsError) {
      this.#listEl.replaceChildren(h("div", { class: "nav-note warn", text: `Could not load the missions: ${this.#missionsError}` }));
      return;
    }
    if (!missions) {
      this.#listEl.replaceChildren(h("div", { class: "empty", text: "Loading missions…" }));
      return;
    }
    if (missions.length === 0) {
      this.#listEl.replaceChildren(h("div", { class: "empty", text: "The robot has no missions yet. Make one in Mission Builder and deploy it to the robot." }));
      return;
    }
    const query = this.#searchInput.hidden ? "" : this.#search;
    const shown = query === "" ? missions : missions.filter((m) => `${m.title ?? ""} ${m.name} ${m.description ?? ""}`.toLowerCase().includes(query));
    if (shown.length === 0) {
      this.#listEl.replaceChildren(h("div", { class: "empty", text: `No mission matches "${this.#searchInput.value.trim()}"` }));
      return;
    }
    this.#listEl.replaceChildren(...shown.map((m) => this.#missionRow(m)));
  }

  #missionRow(m: MissionSummary): HTMLElement {
    const state = this.#stateOf(m);
    const tipLines = [m.description || "", m.triggers?.length ? `Triggers: ${m.triggers.join("; ")}` : "", ...(m.trigger_problems ?? []).map((p) => `Not armed: ${p}`)].filter((s) => s !== "");
    const errors = m.errors ?? [];
    const run = h("button", { class: "primary", title: errors.length > 0 ? `This mission has errors: ${errors.map((e) => e.message).join("; ")}` : `Run ${m.title || m.name}` }, icon("play"), this.#busy === m.name ? "…" : "Run");
    run.disabled = this.#busy !== "" || errors.length > 0;
    run.addEventListener("click", () => void this.#pressRun(m));

    // The dock is narrow: the title gets the line, the name goes with the triggers below it.
    const name = h("div", { class: "name" }, h("span", { class: "title", text: m.title || m.name }));
    if (state !== "idle") name.append(chip(state));
    const triggers = m.triggers?.length ? m.triggers.join(" · ") : "run by hand";
    const meta = m.title && m.title !== m.name ? `${m.name} · ${triggers}` : triggers;
    const info = h("div", { class: "info", title: tipLines.join("\n") }, name, h("div", { class: `meta${m.trigger_problems?.length ? " warn" : ""}`, text: meta }));
    const rowEl = h("div", { class: "mission-row" }, info, run);
    if (this.#form?.name !== m.name) return rowEl;
    return h("div", { class: "mission-item open" }, rowEl, this.#formBlock(this.#form));
  }

  #stateOf(m: MissionSummary): string {
    const status = this.#status;
    if (!status) return m.state ?? "idle";
    if (status.run?.mission === m.name) return status.run.status;
    if (status.queue?.some((r) => r.mission === m.name)) return "queued";
    if (status.suspended?.some((r) => r.mission === m.name)) return "suspended";
    return "idle";
  }

  #formBlock(form: RunForm): HTMLElement {
    const parts: HTMLElement[] = [];
    const inputs = Object.entries(form.doc?.inputs ?? {});
    for (const [key, def] of inputs) parts.push(this.#inputRow(form, key, def));
    const note = this.#preemptNote(form.doc);
    if (note) parts.push(h("div", { class: "nav-note warn", text: note }));
    if (form.error) parts.push(h("div", { class: "nav-note warn", text: form.error }));
    const go = h("button", { class: note ? "danger" : "primary" }, icon("play"), this.#busy === form.name ? "Starting…" : note ? "Run anyway" : "Run");
    go.disabled = this.#busy !== "";
    go.addEventListener("click", () => void this.#submitForm());
    const cancel = h("button", {}, "Cancel");
    cancel.addEventListener("click", () => {
      this.#form = null;
      this.#renderList();
    });
    parts.push(h("div", { class: "nav-buttons" }, go, cancel));
    return h("div", { class: "mission-form" }, ...parts);
  }

  #inputRow(form: RunForm, key: string, def: InputDef): HTMLElement {
    const label = h("label", { text: `${def.label || key}${def.required ? " *" : ""}`, title: [def.description, `${key} (${def.type})`].filter(Boolean).join("\n") });
    let control: HTMLElement;
    if (def.type === "boolean") {
      const box = h("input", { type: "checkbox" });
      box.checked = form.values[key] === true;
      box.addEventListener("change", () => (form.values[key] = box.checked));
      control = box;
    } else if (def.type === "json") {
      const area = h("textarea", { rows: 2, placeholder: def.description || "JSON" });
      area.value = String(form.values[key] ?? "");
      area.addEventListener("input", () => (form.values[key] = area.value));
      control = area;
    } else {
      const input = h("input", { type: def.type === "number" ? "number" : "text", placeholder: def.description || (def.type === "site" ? "site name" : "") });
      input.value = String(form.values[key] ?? "");
      input.addEventListener("input", () => (form.values[key] = input.value));
      if (def.type === "site" && this.#siteNames.length > 0) {
        const listId = `mission-sites-${form.name}-${key}`;
        input.setAttribute("list", listId);
        control = h("span", { class: "with-list" }, input, h("datalist", { id: listId }, ...this.#siteNames.map((s) => h("option", { value: s }))));
      } else {
        control = input;
      }
    }
    return h("div", { class: "row" }, label, control);
  }

  #renderHistory(): void {
    if (!this.#host.settings.missions.historyOpen) {
      this.#historyEl.replaceChildren();
      return;
    }
    if (this.#runsError) {
      this.#historyEl.replaceChildren(h("div", { class: "nav-note warn", text: `Could not load the run history: ${this.#runsError}` }));
      return;
    }
    const runs = this.#runs;
    if (!runs) {
      this.#historyEl.replaceChildren(h("div", { class: "empty", text: "Loading runs…" }));
      return;
    }
    if (runs.length === 0) {
      this.#historyEl.replaceChildren(h("div", { class: "empty", text: "No runs yet" }));
      return;
    }
    this.#historyEl.replaceChildren(...runs.map((run) => this.#runRow(run)));
  }

  #runRow(run: Run): HTMLElement {
    const started = run.started_at ?? run.created_at ?? null;
    const duration = run.started_at && run.finished_at ? (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000 : NaN;
    const open = this.#openRun === run.id;
    const head = h(
      "div",
      { class: "run-head", title: `${run.id}${run.source ? `\nstarted by ${run.source.kind}${run.source.detail ? `: ${run.source.detail}` : ""}` : ""}\nClick for the steps` },
      h("span", { class: "caret", text: open ? "▾" : "▸" }),
      chip(run.status),
      h("span", { class: "title", text: this.#title(run.mission) }),
      h("span", { class: "when", text: started ? formatWhen(started) : "not started" }),
      h("span", { class: "dur", text: Number.isFinite(duration) ? formatDuration(duration) : run.finished_at ? "" : "…" }),
    );
    head.addEventListener("click", () => void this.#toggleRun(run.id));
    const parts: HTMLElement[] = [head];
    if (run.error) parts.push(h("div", { class: `run-error${run.status === "failed" ? " failed" : ""}`, text: run.error }));
    if (open) parts.push(this.#timeline(run));
    return h("div", { class: `run-row ${run.status}${open ? " open" : ""}` }, ...parts);
  }

  #timeline(run: Run): HTMLElement {
    const detail = this.#details.get(run.id);
    if (detail === undefined) return h("div", { class: "empty", text: "Loading steps…" });
    if (typeof detail === "string") return h("div", { class: "nav-note warn", text: `Could not load this run: ${detail}` });
    const steps = timelineOf(detail);
    // A step that never reported finishing (an `end` step, or one cut short) ended with the run.
    const finished = detail.status === "succeeded" || detail.status === "failed" || detail.status === "canceled";
    if (finished) for (const s of steps) if (s.status === undefined) s.status = detail.status;
    if (steps.length === 0) return h("div", { class: "empty", text: "No steps were recorded for this run" });
    const t0 = steps[0]!.start;
    return h(
      "div",
      { class: "run-timeline" },
      ...steps.map((s) =>
        h(
          "div",
          { class: `run-step ${s.status ?? "running"}${s.marker ? " marker" : ""}`, title: s.marker ? `Run ${s.name}` : `${s.id} (${s.type})${s.error ? `\n${s.error}` : ""}` },
          h("span", { class: "at", text: `+${formatDuration(s.start - t0)}` }),
          h("span", { class: "dot" }),
          h("span", { class: "name", style: s.depth > 0 ? `padding-left: ${s.depth * 12}px` : undefined, text: s.marker ? `run ${s.name}` : stepLabel(s.id, s.name, s.type) }),
          h("span", { class: "dur", text: s.end !== undefined && !s.marker ? formatDuration(s.end - s.start) : "" }),
          ...(s.error ? [h("span", { class: "err", text: s.error })] : []),
        ),
      ),
    );
  }
}

// ----- helpers ---------------------------------------------------------------

function chip(status: string): HTMLElement {
  return h("span", { class: `nav-chip ${status}`, text: status });
}

/** "Pick up (pickup)" for a named step, "lap · nav.follow_waypoints" for an unnamed one. */
function stepLabel(id: string, name?: string, type?: string): string {
  if (name && name !== id && name !== type) return `${name} (${id})`;
  return type ? `${id} · ${type}` : id;
}

function queueKey(status: RunnerStatus | null): string {
  return [...(status?.queue ?? []), ...(status?.suspended ?? [])].map((r) => `${r.mission}:${r.status}`).join(",");
}

function initialValue(def: InputDef): string | boolean {
  if (def.type === "boolean") return def.default === true;
  if (def.default === undefined || def.default === null) return "";
  return typeof def.default === "string" ? def.default : JSON.stringify(def.default);
}

/** Where the step sits in the top level of the flow, or -1. */
function topIndex(path: Path | undefined, id: string, flow: { id?: string }[]): number {
  if (path && path.length > 0) {
    const first = path[0];
    if (first === "flow" && typeof path[1] === "number") return path[1];
    if (typeof first === "number") return first;
    if (typeof first === "string") {
      const i = flow.findIndex((s) => s.id === first);
      if (i >= 0) return i;
    }
  }
  return flow.findIndex((s) => s.id === id);
}

/** Pair each step.started with its step.finished. */
function timelineOf(detail: RunDetail): TimelineStep[] {
  const steps: TimelineStep[] = [];
  for (const ev of detail.events ?? []) {
    const t = typeof ev.t === "number" ? ev.t : Date.parse(String(ev.t)) / 1000;
    if (ev.type === "step.started" && ev.step_id) {
      // ["flow", 1, "body", 0] is one level down.
      const depth = Array.isArray(ev.path) ? Math.max(0, Math.floor(ev.path.length / 2) - 1) : 0;
      steps.push({ id: ev.step_id, name: typeof ev.name === "string" ? ev.name : "", type: typeof ev.step_type === "string" ? ev.step_type : "", depth, start: t });
    } else if (ev.type === "run.paused" || ev.type === "run.resumed") {
      const word = ev.type === "run.paused" ? "paused" : "resumed";
      steps.push({ id: word, name: word, type: "", depth: 0, marker: true, start: t, end: t, status: word });
    } else if (ev.type === "step.finished" && ev.step_id) {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]!;
        if (s.id === ev.step_id && s.end === undefined) {
          const result = ev.result && typeof ev.result === "object" ? (ev.result as { ok?: boolean; status?: string; error?: string }) : {};
          s.end = t;
          s.status = result.status || (result.ok === false ? "failed" : "succeeded");
          if (result.error) s.error = result.error;
          break;
        }
      }
    }
  }
  return steps;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function message(err: unknown): string {
  if (err instanceof MissionApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
