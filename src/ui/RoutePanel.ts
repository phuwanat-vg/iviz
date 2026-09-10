/**
 * Route mode: the sidebar that replaces iViz's layer list, and the tool strip
 * over the 3D view.
 *
 * It owns the conversation with mission_runner (through `MissionApi`, i.e. the
 * one `/mission/api` service call), the stop editor, the action forms and the
 * run controls. Everything it edits lives in the `RouteStore`; the scene is
 * drawn by `RouteLayer`, which reads the same store.
 *
 * The panel is written for an operator who has never seen it before, so it is
 * arranged as: what is running (header) → the stops → the selected thing →
 * saving. A section with nothing in it is not drawn at all; instead the panel
 * shows one guided card that says what to do next (draw points, open a
 * mission, add the first stop).
 */

import { h, row, section } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { actionForm, actionPicker, selectInput, stepForChoice, textInput } from "./ActionForm";
import type { ActionChoice, FormContext } from "./ActionForm";
import { RouteTools, TOOL_LINK, TOOL_POINT, TOOL_SELECT } from "./RouteTools";
import type { MissionApi, MissionSummary, RunnerEvent, RunnerStatus } from "../mission/MissionApi";
import { MissionApiError } from "../mission/MissionApi";
import type { RouteStore } from "../mission/RouteStore";
import { nextStepId } from "../mission/RouteStore";
import type { RouteLayer } from "../viz/layers/RouteLayer";
import type { Viewer } from "../viz/Viewer";
import type { AppSettings } from "../state/settings";
import type { Capabilities } from "../mission/MissionApi";
import type { Edge, Mission, SiteKind, Step } from "../mission/types";
import { SITE_KINDS } from "../mission/types";
import { blockDefOrUnknown, stepSummaryShort, stepTitle } from "../mission/blocks";
import { validate } from "../mission/validate";
import type { Finding } from "../mission/types";
import { assignIds } from "../mission/ids";
import { planRoute, stopDestination, stopLabel } from "../mission/stops";
import { normalizeYaw, round1, round3 } from "../mission/geometry";

export interface RoutePanelOptions {
  api: MissionApi;
  store: RouteStore;
  viewer: Viewer;
  layer: RouteLayer;
  viewEl: HTMLElement;
  settings: AppSettings;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
  /** The floor plan: Route mode hides the topic list, so it is toggled here. */
  mapVisible(): boolean;
  setMapVisible(visible: boolean): void;
}

type PickMode = null | { purpose: "add-stop" };

/** A message the panel keeps on screen, with the technical detail folded away. */
interface Notice {
  kind: "error" | "info";
  text: string;
  detail?: string;
}

export class RoutePanel {
  readonly element = h("div", { class: "sidebar route-panel" });
  readonly toolbar = h("div", { class: "route-toolbar" });

  #o: RoutePanelOptions;
  #tools: RouteTools;
  #active = false;
  #busy = false;

  #missions: MissionSummary[] = [];
  #connectors: string[] = [];
  #capabilities: Capabilities | null = null;
  #status: RunnerStatus | null = null;
  #findings: Finding[] = [];
  #notice: Notice | null = null;
  #pick: PickMode = null;
  #menuOpen = false;

  // run state, derived from /mission/event
  #activeStop: number | null = null;
  #doneStops = new Set<number>();
  #failedStop: number | null = null;

  #unsubs: (() => void)[] = [];
  #nameInput?: HTMLInputElement;
  #framedOnce = false;

  constructor(opts: RoutePanelOptions) {
    this.#o = opts;
    this.#tools = new RouteTools({
      viewer: opts.viewer,
      store: opts.store,
      layer: opts.layer,
      promptName: (name, x, y) => this.#promptName(name, x, y),
      refresh: () => this.render(),
      onPointPicked: (name) => this.#pickPoint(name),
      onDragHint: (text) => this.#setDragHint(text),
    });
    this.#buildToolbar();
    this.#unsubs.push(opts.store.onChange(() => this.render()));
    this.#unsubs.push(opts.api.onStatus((s) => this.#onStatus(s)));
    this.#unsubs.push(opts.api.onEvent((e) => this.#onEvent(e)));
    this.#unsubs.push(opts.api.onAvailabilityChange((ok) => this.#onAvailability(ok)));
    window.addEventListener("keydown", this.#onKeyDown);
    this.render();
  }

  /** App forwards the Viewer's tool changes so both tool bars stay in sync. */
  onToolChanged(tool: string): void {
    if (this.#active) {
      this.#syncToolButtons(tool);
      this.#refreshHint();
    }
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKeyDown);
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
    this.#tools.dispose();
  }

  get active(): boolean {
    return this.#active;
  }

  /** Turn Route mode on or off. */
  setActive(on: boolean): void {
    if (on === this.#active) return;
    this.#active = on;
    this.#o.layer.visible = on;
    this.toolbar.hidden = !on;
    if (on) {
      this.#o.api.startLiveState();
      this.#o.viewer.setTool(TOOL_SELECT);
      void this.reload();
    } else {
      this.#o.api.stopLiveState();
      if (String(this.#o.viewer.tool).startsWith("route.")) this.#o.viewer.setTool("none");
      this.#hideNameInput();
      this.#pick = null;
    }
    this.render();
  }

  /** Fetch everything Route mode needs from the runner. */
  async reload(): Promise<void> {
    const { api, store } = this.#o;
    if (!api.available) {
      this.render();
      return;
    }
    this.#busy = true;
    this.render();
    try {
      const [sites, missions, status] = await Promise.all([api.sites(), api.missions(), api.status()]);
      store.setSites(sites);
      this.#missions = missions;
      this.#status = status;
      this.#connectors = Object.keys(status.connectors ?? {});
      try {
        const caps = await api.capabilities();
        this.#capabilities = caps;
        if (Array.isArray(caps.connectors) && caps.connectors.length) this.#connectors = caps.connectors;
      } catch {
        this.#capabilities = null;
      }
      try {
        this.#connectors = Object.keys(await api.connectors());
      } catch {
        /* keep what status gave us */
      }
      const wanted = this.#o.settings.routeMission;
      if (wanted && missions.some((m) => m.name === wanted)) await this.#openMission(wanted);
      else store.setMission(null);
      // Opening on a view of empty floor helps nobody: frame the graph once.
      if (!this.#framedOnce) {
        this.#framedOnce = true;
        this.#fit();
      }
    } catch (err) {
      this.#fail("iViz could not read the missions from the robot.", err);
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  // ---- rendering ----------------------------------------------------------

  render(): void {
    if (!this.#active) {
      this.element.replaceChildren();
      return;
    }
    const { api, store } = this.#o;
    if (!api.available) {
      this.element.replaceChildren(
        card([
          h("div", { class: "card-title", text: "Route mode is not available" }),
          h("p", { class: "prose", text: api.unavailableReason }),
          h("p", { class: "prose", text: "iViz keeps working as a viewer. Route mode needs mission_runner running on the robot with mission_msgs built, published through foxglove_bridge." }),
        ]),
      );
      return;
    }
    const parts: HTMLElement[] = [this.#header()];
    if (this.#notice) parts.push(this.#noticeCard(this.#notice));

    const hasPoints = Object.keys(store.points).length > 0;
    if (!hasPoints) parts.push(this.#firstRunCard());
    if (store.mission) {
      if (store.stops.length) parts.push(this.#stopsSection());
      else if (hasPoints) parts.push(this.#firstStopCard());
    } else if (hasPoints) {
      parts.push(this.#chooseMissionCard());
    }

    const selected = this.#selectedSection();
    if (selected) {
      selected.classList.add("selected-section");
      parts.push(selected);
    }
    if (store.mission && store.flow.others.length) parts.push(this.#otherStepsSection());
    const save = this.#saveSection();
    if (save) parts.push(save);

    // Keep the reading position: the panel re-renders on every edit.
    const scroll = this.element.scrollTop;
    this.element.replaceChildren(...parts);
    this.element.scrollTop = scroll;
    // Clicking a point on the map has to show that point's panel, and the list
    // of stops above it can be long, so a new selection brings its own section
    // into view. Only on a change, or the panel would fight the scroll wheel.
    const key = selectionKey(this.#o.store.selection);
    if (key !== this.#lastSelection) {
      this.#lastSelection = key;
      if (key !== "none") this.element.querySelector(".selected-section")?.scrollIntoView({ block: "nearest" });
    }
    this.#syncToolButtons(String(this.#o.viewer.tool));
    this.#refreshHint();
  }

  #lastSelection = "none";

  /**
   * Live state arrives once or twice a second. Rebuilding the panel that often
   * would throw away the scroll position and the focused field, so run marks
   * and the status line are patched into the DOM that is already there.
   */
  #refreshLive(): void {
    if (!this.#active) return;
    const line = this.element.querySelector(".status-line");
    if (!line) {
      this.render();
      return;
    }
    const fresh = this.#statusLine();
    line.replaceChildren(...Array.from(fresh.childNodes));
    line.className = fresh.className;
    const cards = this.element.querySelectorAll(".stops > .stop");
    cards.forEach((card, i) => {
      card.classList.toggle("active", this.#activeStop === i);
      card.classList.toggle("done", this.#doneStops.has(i));
      card.classList.toggle("failed", this.#failedStop === i);
    });
  }

  // ---- header -------------------------------------------------------------

  /** Mission name, what the robot is doing, and the run controls. */
  #header(): HTMLElement {
    const { store } = this.#o;
    const mission = store.mission;
    const summary = mission ? this.#missions.find((m) => m.name === mission.name) : undefined;
    const title = mission ? mission.title?.trim() || summary?.title?.trim() || mission.name : "No mission open";
    const head = h("div", { class: "route-title-row" }, h("div", { class: "route-title", text: title, title: mission ? mission.name : "" }));
    const menuBtn = button("chevronDown", "Change", "small", () => {
      this.#menuOpen = !this.#menuOpen;
      this.render();
    });
    menuBtn.title = "Choose a mission, the map, and what the view shows";
    menuBtn.classList.toggle("active-tool", this.#menuOpen);
    head.appendChild(menuBtn);

    const run = button("play", "Run", "primary big", () => void this.#run());
    const pause = button("pause", this.#status?.state === "paused" ? "Resume" : "Pause", "", () => void this.#pauseOrResume());
    const stop = button("stop", "Stop", "danger", () => void this.#stop());
    run.disabled = !mission || this.#busy;
    run.title = mission ? `Run ${mission.name} on the robot` : "Open a mission first";
    pause.disabled = !this.#status?.run;
    stop.disabled = !this.#status?.run;

    const body: HTMLElement[] = [head, this.#statusLine(), h("div", { class: "row buttons run-row" }, run, pause, stop)];

    const prompt = this.#status?.prompt;
    if (prompt) {
      const buttons = (prompt.options ?? []).map((o) => button("message", o, "", () => void this.#answer(prompt.id, o)));
      body.push(h("div", { class: "prompt-banner" }, h("div", { class: "prompt-text", text: `The robot is asking: ${prompt.text}` }), h("div", { class: "row buttons" }, ...buttons)));
    }
    if (this.#menuOpen) body.push(this.#menuCard());
    return h("div", { class: "route-header" }, ...body);
  }

  /** Everything that is not a run control: mission, map, layers, reload. */
  #menuCard(): HTMLElement {
    const { store, settings, layer } = this.#o;
    const names = this.#missions.map((m) => m.name);
    const sel = selectInput(names, store.mission?.name ?? "", true, (v) => {
      settings.routeMission = v;
      this.#o.persist();
      this.#menuOpen = false;
      if (v === "") store.setMission(null);
      else void this.#openMission(v);
    });
    sel.title = "The mission to edit and run";
    const mapSel = selectInput(store.mapNames, store.mapName, false, (v) => store.setMapName(v));
    mapSel.title = "The floor this route graph belongs to";

    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
      const chk = h("input", { type: "checkbox" });
      chk.checked = get();
      chk.addEventListener("change", () => set(chk.checked));
      return h("label", { class: "inline-check" }, chk, h("span", { text: label }));
    };
    const refresh = button("refresh", "Reload from the robot", "", () => void this.reload());
    refresh.title = "Throw away nothing; re-read the points, lanes and missions the robot has";
    return h(
      "div",
      { class: "menu-card" },
      row("Mission", sel),
      row("Map", mapSel),
      h("div", { class: "row wrap" }, h("label", { text: "Show on the map" }), toggle("Floor plan", () => this.#o.mapVisible(), (v) => this.#o.setMapVisible(v)), toggle("Points", () => layer.showPoints, (v) => (layer.showPoints = v)), toggle("Lanes", () => layer.showLanes, (v) => (layer.showLanes = v)), toggle("Mission route", () => layer.showRoute, (v) => (layer.showRoute = v))),
      h("div", { class: "row" }, refresh),
    );
  }

  /** One sentence about what the robot is doing right now. */
  #statusLine(): HTMLElement {
    const s = this.#status;
    if (!s) return h("div", { class: "status-line waiting" }, h("span", { class: "dot" }), h("span", { text: "Waiting for the robot to report in…" }));
    let state = "idle";
    let text = "Nothing is running.";
    if (s.state === "running" && s.run) {
      state = "running";
      const step = s.run.step?.name || s.run.step?.id || "";
      text = step ? `Running ${s.run.mission} — ${step}` : `Running ${s.run.mission}`;
    } else if (s.state === "paused" && s.run) {
      state = "paused";
      text = `Paused in ${s.run.mission}. Press Resume to carry on.`;
    }
    const extras: string[] = [];
    const queue = s.queue?.length ?? 0;
    if (queue) extras.push(queue === 1 ? "1 run is waiting its turn." : `${queue} runs are waiting their turn.`);
    const suspended = s.suspended?.length ?? 0;
    if (suspended) extras.push(suspended === 1 ? "1 run is suspended." : `${suspended} runs are suspended.`);
    if (s.run?.error) extras.push(`The last error was: ${s.run.error}`);
    const el = h("div", { class: `status-line ${state}` }, h("span", { class: "dot" }), h("span", { text: [text, ...extras].join(" ") }));
    return el;
  }

  // ---- guided empty states ------------------------------------------------

  /** Nothing has been drawn on this map yet: the three steps, in order. */
  #firstRunCard(): HTMLElement {
    const steps: { n: number; title: string; body: string; button: HTMLElement }[] = [
      {
        n: 1,
        title: "Draw the stops the robot should visit",
        body: "Click the floor wherever the robot should be able to stand. Drag before you let go to set which way it faces.",
        button: button("mapPin", "Use the Point tool", "step-btn", () => this.#o.viewer.setTool(TOOL_POINT)),
      },
      {
        n: 2,
        title: "Connect them so the robot only drives your lanes",
        body: "Drag from one point to another. The robot never leaves the lanes you draw here.",
        button: button("link", "Use the Link tool", "step-btn", () => this.#o.viewer.setTool(TOOL_LINK)),
      },
      {
        n: 3,
        title: "Put the stops in order and add what happens at each one",
        body: "Open a mission, add points to it as stops, then give each stop its actions.",
        button: button("waypoints", "Open a mission", "step-btn", () => {
          this.#menuOpen = true;
          this.render();
        }),
      },
    ];
    const body: HTMLElement[] = [
      h("div", { class: "card-title", text: "This map has nothing on it yet" }),
      h("p", { class: "prose", text: "Three steps and the robot has somewhere to go." }),
    ];
    for (const s of steps) {
      const keyHint = s.n === 1 ? "N" : s.n === 2 ? "L" : "";
      const head = h("div", { class: "guide-head" }, h("span", { class: "guide-no", text: String(s.n) }), h("span", { class: "guide-title", text: s.title }));
      if (keyHint) head.appendChild(h("kbd", { text: keyHint }));
      body.push(h("div", { class: "guide-step" }, head, h("p", { class: "prose", text: s.body }), s.button));
    }
    return card(body, "guide-card");
  }

  /** There is a graph but no mission: say what a mission is and offer the list. */
  #chooseMissionCard(): HTMLElement {
    const names = this.#missions.map((m) => m.name);
    const body: HTMLElement[] = [h("div", { class: "card-title", text: "Choose a mission to plan" })];
    if (names.length) {
      body.push(h("p", { class: "prose", text: "The points and lanes on this map are shared by every mission. A mission is the order the robot visits them in, and what it does when it gets there." }));
      const sel = selectInput(names, "", true, (v) => {
        if (v === "") return;
        this.#o.settings.routeMission = v;
        this.#o.persist();
        void this.#openMission(v);
      });
      body.push(row("Mission", sel));
    } else {
      body.push(h("p", { class: "prose", text: "The robot has no missions yet. Create one with mission_runner (or the phone page), then reload here and it will be in the list." }));
      body.push(h("div", { class: "row" }, button("refresh", "Reload from the robot", "", () => void this.reload())));
    }
    return card(body, "guide-card");
  }

  /** A mission is open but empty: get the first stop in. */
  #firstStopCard(): HTMLElement {
    const { store } = this.#o;
    const pickBtn = button("target", this.#pick ? "Now click a point on the map" : "Pick the first stop on the map", "primary", () => this.#startAddStop());
    if (this.#pick) pickBtn.classList.add("active-tool");
    const pickList = selectInput(Object.keys(store.points), "", true, (v) => {
      if (v) {
        store.addStop(v);
        this.#pick = null;
      }
    });
    pickList.title = "Or choose a point from the list";
    return card(
      [
        h("div", { class: "card-title", text: "This mission has no stops yet" }),
        h("p", { class: "prose", text: "A stop is one of your points plus what happens when the robot arrives. Click the button, then click the point on the map the robot should drive to first." }),
        h("div", { class: "row" }, pickBtn),
        row("Or from the list", pickList),
      ],
      "guide-card",
    );
  }

  #noticeCard(n: Notice): HTMLElement {
    const body: HTMLElement[] = [h("div", { class: "card-title" }, icon(n.kind === "error" ? "alert" : "info"), h("span", { text: n.kind === "error" ? "That did not work" : "Done" })), h("p", { class: "prose", text: n.text })];
    if (n.detail) {
      const det = h("details", { class: "detail" }, h("summary", { text: "Details" }), h("pre", { text: n.detail }));
      body.push(det);
    }
    const close = button("close", "", "icon-only", () => {
      this.#notice = null;
      this.render();
    });
    close.title = "Dismiss";
    const el = card(body, `notice-card ${n.kind}`);
    el.appendChild(close);
    return el;
  }

  // ---- stops --------------------------------------------------------------

  #stopsSection(): HTMLElement {
    const { store } = this.#o;
    const stops = store.stops;
    const legs = planRoute(stops, store.points, store.lanes, store.mission);
    const problems = new Map<number, string>();
    for (const leg of legs) if (leg.problem) problems.set(leg.stopIndex, leg.problem);

    const list = h("div", { class: "stops" });
    stops.forEach((stop, i) => {
      const selected = store.selection.kind === "stop" && store.selection.index === i;
      const dest = stopDestination(stop, store.mission);
      const label = stopLabel(stop);
      const where = dest.site ?? dest.raw;
      const head = h(
        "div",
        { class: "stop-head" },
        h("span", { class: "grip", title: "Drag to put the stops in another order" }, icon("grip")),
        h("span", { class: "no", text: String(i + 1) }),
        h("div", { class: "stop-text" }, h("div", { class: "name", text: label }), h("div", { class: "where", text: where && where !== label ? `Drives to ${where}` : "Drives here" })),
      );
      const del = button("trash", "", "icon-only danger", () => store.removeStop(i));
      del.title = `Remove stop ${i + 1}`;
      del.addEventListener("click", (e) => e.stopPropagation());
      head.appendChild(del);
      const card = h("div", { class: `stop${selected ? " selected" : ""}${this.#activeStop === i ? " active" : ""}${this.#doneStops.has(i) ? " done" : ""}${this.#failedStop === i ? " failed" : ""}` }, head);
      head.addEventListener("click", () => store.select({ kind: "stop", index: i }));
      if (dest.input) card.appendChild(h("div", { class: "note-line", text: `Whoever starts the mission chooses this one, through the "${dest.input}" input.` }));
      if (dest.site === null) card.appendChild(h("div", { class: "warn-line", text: "The destination is only known while the mission runs, so this stop cannot be drawn on the map." }));
      const problem = problems.get(i);
      if (problem) card.appendChild(h("div", { class: "warn-line", text: sentence(problem) }));
      for (const action of stop.actions) card.appendChild(this.#actionSummary(i, action));
      card.draggable = true;
      card.dataset.index = String(i);
      list.appendChild(card);
    });
    makeReorderable(list, ".stop", (from, to) => store.moveStop(from, to));

    const addStop = button("plus", this.#pick ? "Now click a point on the map" : "Add a stop", "", () => this.#startAddStop());
    if (this.#pick) addStop.classList.add("active-tool");
    addStop.title = "Click here, then click the point on the map the robot should drive to";
    const pickList = selectInput(Object.keys(store.points), "", true, (v) => {
      if (v) {
        store.addStop(v);
        this.#pick = null;
      }
    });
    pickList.title = "Or choose a point from the list";

    return section("The stops, in order", [list, h("div", { class: "row buttons" }, addStop, pickList)], false, "waypoints");
  }

  /** One line under a stop in the list; editing happens in "Selected stop". */
  #actionSummary(stopIndex: number, action: Step): HTMLElement {
    const { store } = this.#o;
    const def = blockDefOrUnknown(action.type);
    const summary = store.mission ? stepSummaryShort(action, { mission: store.mission }) : "";
    const el = h("div", { class: "action" }, h("div", { class: "action-head" }, icon(def.icon), h("span", { class: "name", text: stepTitle(action) }), h("span", { class: "sum", text: summary })));
    el.addEventListener("click", () => store.select({ kind: "stop", index: stopIndex }));
    return el;
  }

  // ---- the selected thing -------------------------------------------------

  /** Null when nothing is selected: the section is not drawn at all. */
  #selectedSection(): HTMLElement | null {
    const sel = this.#o.store.selection;
    if (sel.kind === "point") return this.#pointSection(sel.name);
    if (sel.kind === "lane") return this.#laneSection(sel.index);
    if (sel.kind === "stop") return this.#stopSection(sel.index);
    return null;
  }

  #pointSection(name: string): HTMLElement {
    const { store } = this.#o;
    const site = store.points[name];
    if (!site) return section("Selected point", [h("p", { class: "prose", text: "That point is not here any more." })], false, "mapPin");
    const nameInput = textInput(name, "Name", (v) => {
      const next = store.renamePoint(name, v);
      if (next !== v.trim() && v.trim() !== "") this.#o.toast(`There is already a point called "${v.trim()}", so the name was left alone.`);
      this.render();
    });
    const numberField = (value: number, step: number, onSet: (v: number) => void): HTMLInputElement => {
      const inp = h("input", { type: "number", value: String(value), step: String(step) });
      inp.addEventListener("change", () => {
        const n = parseFloat(inp.value);
        if (Number.isFinite(n)) onSet(n);
      });
      return inp;
    };
    const body: HTMLElement[] = [
      row("Name", nameInput),
      row("x (m)", numberField(site.x, 0.05, (v) => store.edit("Move point", () => store.movePoint(name, v, site.y)))),
      row("y (m)", numberField(site.y, 0.05, (v) => store.edit("Move point", () => store.movePoint(name, site.x, v)))),
      row(
        "Facing (deg)",
        numberField(typeof site.yaw_deg === "number" ? round1(site.yaw_deg) : 0, 5, (v) => store.edit("Set heading", () => store.setPointYaw(name, normalizeYaw(v)))),
        (() => {
          const b = button("close", "", "icon-only", () => store.edit("Clear heading", () => store.setPointYaw(name, null)));
          b.title = "Let the robot arrive facing any way";
          return b;
        })(),
      ),
      row("Kind", selectInput(SITE_KINDS as readonly string[], site.kind ?? "station", false, (v) => store.setPointKind(name, v as SiteKind))),
    ];

    const lanes = store.lanes.map((lane, index) => ({ lane, index })).filter((l) => l.lane.from === name || l.lane.to === name);
    body.push(h("div", { class: "sub-title", text: `Lanes that touch this point (${lanes.length})` }));
    if (!lanes.length) body.push(h("p", { class: "prose", text: "No lane reaches this point yet, so the robot cannot drive to it. Draw one with the Link tool (L)." }));
    for (const { lane, index } of lanes) body.push(this.#laneRow(lane, index));

    const del = button("trash", "Delete this point", "danger", () => this.#deletePoint(name));
    const addStop = button("plus", "Add as a stop", "", () => {
      if (store.mission) store.addStop(name);
      else {
        this.#menuOpen = true;
        this.#o.toast("Open a mission first — then this point can become a stop in it.");
        this.render();
      }
    });
    body.push(h("div", { class: "row buttons" }, addStop, del));
    return section(`Point: ${name}`, body, false, "mapPin");
  }

  #laneRow(lane: Edge, index: number): HTMLElement {
    const { store } = this.#o;
    const selected = store.selection.kind === "lane" && store.selection.index === index;
    const title = h("div", { class: "lane-title", text: `${lane.from} ${lane.bidirectional === false ? "→" : "↔"} ${lane.to}` });
    title.addEventListener("click", () => store.select({ kind: "lane", index }));
    const oneWay = h("input", { type: "checkbox", title: "The robot may only drive from the first point to the second" });
    oneWay.checked = lane.bidirectional === false;
    oneWay.addEventListener("change", () => store.updateLane(index, { bidirectional: oneWay.checked ? false : undefined }));
    const blocked = h("input", { type: "checkbox", title: "Closed for now; the robot plans around it" });
    blocked.checked = lane.blocked === true;
    blocked.addEventListener("change", () => store.updateLane(index, { blocked: blocked.checked ? true : undefined }));
    const speed = h("input", { type: "number", step: "0.05", min: "0", value: typeof lane.speed_mps === "number" ? String(lane.speed_mps) : "", placeholder: "no cap", title: "Top speed on this lane, in metres per second" });
    speed.addEventListener("change", () => {
      const n = parseFloat(speed.value);
      store.updateLane(index, { speed_mps: Number.isFinite(n) && n > 0 ? round3(n) : undefined });
    });
    const del = button("trash", "", "icon-only danger", () => store.deleteLane(index));
    del.title = "Delete this lane";
    return h(
      "div",
      { class: `lane${selected ? " selected" : ""}` },
      title,
      h("div", { class: "row lane-controls" }, h("label", { text: "One-way" }), oneWay, h("label", { text: "Closed" }), blocked, h("label", { text: "Max m/s" }), speed, del),
    );
  }

  #laneSection(index: number): HTMLElement {
    const lane = this.#o.store.lanes[index];
    if (!lane) return section("Selected lane", [h("p", { class: "prose", text: "That lane is not here any more." })], false, "link");
    return section(`Lane: ${lane.from} → ${lane.to}`, [this.#laneRow(lane, index)], false, "link");
  }

  #stopSection(index: number): HTMLElement {
    const { store } = this.#o;
    const stop = store.stops[index];
    if (!stop) return section("Selected stop", [h("p", { class: "prose", text: "That stop is not here any more." })], false, "waypoints");
    const body: HTMLElement[] = [
      h("p", { class: "prose", text: `Stop ${index + 1} of ${store.stops.length}. The robot drives here along the lanes, then does everything listed below before moving on.` }),
      row("Drives to", selectInput(Object.keys(store.points), typeof stop.step.to === "string" ? stop.step.to : "", true, (v) => store.setStopSite(index, v))),
      row("Called", textInput(typeof stop.step.name === "string" ? stop.step.name : "", "(the point's name)", (v) => store.setStepParam(stop.step, "name", v === "" ? undefined : v, "Rename stop"))),
    ];
    body.push(h("div", { class: "sub-title", text: "What happens when it arrives" }));
    if (!stop.actions.length) body.push(h("p", { class: "prose", text: "Nothing yet — the robot arrives and drives straight on. Add an action to make it do something here." }));
    const actions = h("div", { class: "actions" });
    for (const [ai, action] of stop.actions.entries()) {
      const wrap = h("div", { class: "action open" });
      const def = blockDefOrUnknown(action.type);
      const head = h("div", { class: "action-head" }, h("span", { class: "grip", title: "Drag to reorder" }, icon("grip")), icon(def.icon), h("span", { class: "name", text: stepTitle(action) }), h("span", { class: "sum", text: store.mission ? stepSummaryShort(action, { mission: store.mission }) : "" }));
      const up = button("arrowUp", "", "icon-only", () => store.moveAction(index, ai, ai - 1));
      const down = button("arrowDown", "", "icon-only", () => store.moveAction(index, ai, ai + 1));
      const del = button("trash", "", "icon-only danger", () => store.removeAction(index, ai));
      up.title = "Do this one earlier";
      down.title = "Do this one later";
      del.title = "Remove this action";
      up.disabled = ai === 0;
      down.disabled = ai === stop.actions.length - 1;
      head.append(up, down, del);
      wrap.append(head, actionForm(action, this.#formContext(), (key, value) => store.setStepParam(action, key, value)));
      wrap.draggable = true;
      wrap.dataset.index = String(ai);
      actions.appendChild(wrap);
    }
    makeReorderable(actions, ".action", (from, to) => store.moveAction(index, from, to));
    if (stop.actions.length) body.push(actions);
    const add = button("plus", this.#pickerOpen ? "Never mind" : "Add an action", "", () => {
      this.#pickerOpen = !this.#pickerOpen;
      this.render();
    });
    body.push(h("div", { class: "row buttons" }, add));
    if (this.#pickerOpen) {
      body.push(
        actionPicker((choice) => {
          this.#addAction(index, choice);
          this.#pickerOpen = false;
          this.render();
        }),
      );
    }
    return section(`Stop ${index + 1}: ${stopLabel(stop)}`, body, false, "waypoints");
  }

  #pickerOpen = false;

  #otherStepsSection(): HTMLElement {
    const others = this.#o.store.flow.others;
    const rows = others.map((o) => {
      const def = blockDefOrUnknown(o.step.type);
      return h("div", { class: "action muted" }, h("div", { class: "action-head" }, icon(def.icon), h("span", { class: "name", text: stepTitle(o.step) }), h("span", { class: "sum", text: o.reason })));
    });
    return section(
      `Steps that belong to no stop (${others.length})`,
      [h("p", { class: "prose", text: "This mission also has steps that are not part of a stop. iViz keeps them exactly as they are and saves them unchanged; they are edited in the mission's JSON." }), ...rows],
      true,
      "list",
    );
  }

  // ---- saving -------------------------------------------------------------

  /** What is unsaved, in words, and the one button that saves it. */
  #saveSection(): HTMLElement | null {
    const { store } = this.#o;
    const sites = store.sitesDirty;
    const mission = store.missionDirty && store.mission !== null;
    if (!sites && !mission && !store.canUndo && !store.canRedo && !this.#findings.length) return null;

    const what = sites && mission ? "Save both" : mission ? "Save mission" : sites ? "Save map" : "Everything is saved";
    const save = button("upload", what, sites || mission ? "primary big" : "big", () => void this.#saveAll());
    save.disabled = (!sites && !mission) || this.#busy;
    save.title = sites || mission ? "Send the changes to the robot" : "There is nothing new to send";

    const undo = button("undo", "", "icon-only", () => {
      store.undo();
      this.render();
    });
    const redo = button("redo", "", "icon-only", () => {
      store.redo();
      this.render();
    });
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    undo.title = store.canUndo ? `Undo "${store.undoLabel}" (Ctrl+Z)` : "Nothing to undo";
    redo.title = store.canRedo ? "Redo (Ctrl+Y)" : "Nothing to redo";

    const line =
      sites && mission
        ? "The map (points and lanes) and this mission have changes that only exist on this computer."
        : mission
          ? "This mission has changes that only exist on this computer."
          : sites
            ? "The points and lanes have changes that only exist on this computer."
            : "Everything here is on the robot.";
    const body: HTMLElement[] = [h("p", { class: `prose${sites || mission ? " unsaved" : ""}`, text: line }), h("div", { class: "row buttons save-row" }, save, undo, redo)];
    if (sites) body.push(h("p", { class: "prose muted", text: "Points and lanes belong to the map, so saving them changes every mission that uses it." }));

    if (this.#findings.length) {
      const errs = this.#findings.filter((f) => f.level === "error").length;
      body.push(h("div", { class: "sub-title", text: errs ? "Fix these before saving" : "Worth a look" }));
      for (const f of this.#findings.slice(0, 20)) {
        const where = f.path.join(" › ");
        body.push(h("div", { class: `finding ${f.level}` }, h("div", { text: sentence(f.message) }), where ? h("div", { class: "where", text: where }) : h("span")));
      }
    }
    return section("Save to the robot", body, false, "upload");
  }

  #formContext(): FormContext {
    return {
      siteNames: Object.keys(this.#o.store.points),
      mapNames: this.#o.store.mapNames,
      connectorNames: this.#connectors,
      missionNames: this.#missions.map((m) => m.name),
    };
  }

  // ---- toolbar ------------------------------------------------------------

  #toolButtons = new Map<string, HTMLButtonElement>();
  #hintEl = h("div", { class: "tool-hint" });
  #dragHint: string | null = null;

  #buildToolbar(): void {
    const mk = (tool: string, iconName: IconName, label: string, key: string): HTMLButtonElement => {
      const b = h("button", { class: "tool" }, icon(iconName, 16), h("span", { class: "lbl", text: label }), h("kbd", { text: key }));
      b.addEventListener("click", () => this.#o.viewer.setTool(tool));
      b.title = `${label} — press ${key}`;
      this.#toolButtons.set(tool, b);
      return b;
    };
    const fit = h("button", { class: "tool" }, icon("maximize", 16), h("span", { class: "lbl", text: "Fit" }));
    fit.title = "Move the camera so the whole route graph is on screen";
    fit.addEventListener("click", () => this.#fit());
    const tools = h("div", { class: "tools" }, mk(TOOL_SELECT, "mousePointer", "Select", "V"), mk(TOOL_POINT, "mapPin", "Point", "N"), mk(TOOL_LINK, "link", "Link", "L"), h("span", { class: "sep" }), fit);
    this.toolbar.replaceChildren(tools, this.#hintEl);
    this.toolbar.hidden = true;
    this.#o.viewEl.appendChild(this.toolbar);
  }

  #syncToolButtons(tool: string): void {
    for (const [name, btn] of this.#toolButtons) btn.classList.toggle("active", name === tool);
  }

  /** The Link tool says what it is about to connect while the drag is live. */
  #setDragHint(text: string | null): void {
    this.#dragHint = text;
    this.#refreshHint();
  }

  #refreshHint(): void {
    if (!this.#active) return;
    let text = this.#dragHint;
    if (text === null && this.#pick) text = "Click the point on the map the robot should drive to. Esc to cancel.";
    if (text === null) text = RouteTools.hintFor(String(this.#o.viewer.tool));
    this.#hintEl.textContent = text;
    this.#hintEl.hidden = text === "";
  }

  #fit(): void {
    const points = Object.values(this.#o.store.points);
    if (!points.length) {
      this.#o.viewer.resetView();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    this.#o.viewer.frameBounds(minX, minY, maxX, maxY);
  }

  // ---- keyboard -----------------------------------------------------------

  #onKeyDown = (e: KeyboardEvent): void => {
    if (!this.#active) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
      if (e.key === "Escape") target.blur();
      return;
    }
    const { store, viewer } = this.#o;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
        this.render();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        store.redo();
        this.render();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        this.#pick = null;
        this.#hideNameInput();
        viewer.setTool(TOOL_SELECT);
        this.render();
        break;
      case "v":
      case "V":
        viewer.setTool(TOOL_SELECT);
        break;
      case "n":
      case "N":
        viewer.setTool(TOOL_POINT);
        break;
      case "l":
      case "L":
        viewer.setTool(TOOL_LINK);
        break;
      case "Delete":
      case "Backspace": {
        const sel = store.selection;
        if (sel.kind === "point") this.#deletePoint(sel.name);
        else if (sel.kind === "lane") store.deleteLane(sel.index);
        else if (sel.kind === "stop") store.removeStop(sel.index);
        break;
      }
      default:
        break;
    }
  };

  #deletePoint(name: string): void {
    const refs = this.#o.store.referencesTo(name);
    if (refs.length && !window.confirm(`"${name}" is still used by ${refs.length === 1 ? "one thing" : `${refs.length} things`}: ${refs.slice(0, 4).join(", ")}${refs.length > 4 ? ", and more" : ""}.\n\nDelete the point anyway? Those will lose their destination.`)) return;
    this.#o.store.deletePoint(name);
    this.render();
  }

  // ---- inline naming ------------------------------------------------------

  #promptName(name: string, x: number, y: number): void {
    const { viewer, viewEl } = this.#o;
    this.#hideNameInput();
    const inp = h("input", { type: "text", class: "inline-name", value: name, title: "Type a name for this point, then press Enter" });
    const screen = viewer.worldToScreenPoint(x, y);
    inp.style.left = `${Math.round(screen.x)}px`;
    inp.style.top = `${Math.round(screen.y)}px`;
    viewEl.appendChild(inp);
    this.#nameInput = inp;
    inp.select();
    inp.focus();
    let done = false;
    const commit = (): void => {
      if (done) return; // removing the input fires blur, which would commit twice
      done = true;
      const value = inp.value.trim();
      this.#hideNameInput();
      if (value && value !== name) this.#o.store.renamePoint(name, value);
      this.render();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") {
        done = true;
        this.#hideNameInput();
        this.render();
      }
      e.stopPropagation();
    });
    inp.addEventListener("blur", commit);
  }

  #hideNameInput(): void {
    this.#nameInput?.remove();
    this.#nameInput = undefined;
  }

  // ---- actions ------------------------------------------------------------

  #startAddStop(): void {
    if (!this.#o.store.mission) {
      this.#menuOpen = true;
      this.#o.toast("Open a mission first — stops belong to a mission.");
      this.render();
      return;
    }
    this.#pick = this.#pick ? null : { purpose: "add-stop" };
    if (this.#pick) this.#o.viewer.setTool(TOOL_SELECT);
    this.render();
  }

  /** The Select tool offers every point click here first (used by "Add stop"). */
  #pickPoint(name: string): boolean {
    if (!this.#pick) return false;
    this.#pick = null;
    this.#o.store.addStop(name);
    this.render();
    return true;
  }

  #addAction(stopIndex: number, choice: ActionChoice): void {
    const mission = this.#o.store.mission;
    if (!mission) return;
    const step = stepForChoice(choice, nextStepId(mission, "act"));
    this.#o.store.addAction(stopIndex, step);
  }

  async #openMission(name: string): Promise<void> {
    try {
      const doc = await this.#o.api.mission(name);
      this.#o.store.setMission(doc);
      this.#o.settings.routeMission = name;
      this.#o.persist();
      this.#findings = [];
      this.#notice = null;
      this.#resetRunMarks();
    } catch (err) {
      this.#fail(`iViz could not open the mission "${name}".`, err);
      this.#o.store.setMission(null);
    }
    this.render();
  }

  async #run(): Promise<void> {
    const mission = this.#o.store.mission;
    if (!mission) return;
    if (this.#o.store.missionDirty && !window.confirm("This mission has changes that are not on the robot yet.\n\nRun the version the robot already has? Press Cancel to go back and save first.")) return;
    try {
      this.#resetRunMarks();
      const res = await this.#o.api.run(mission.name);
      if (res.accepted === false) this.#o.toast(`The robot did not start the mission: ${sentence(res.reason ?? "it refused, without saying why")}`);
      else this.#o.toast(`${mission.name} is on its way.`, "info");
    } catch (err) {
      this.#fail("iViz could not start the mission.", err);
      this.render();
    }
  }

  async #pauseOrResume(): Promise<void> {
    try {
      if (this.#status?.state === "paused") await this.#o.api.resume();
      else await this.#o.api.pause();
    } catch (err) {
      this.#fail("iViz could not pause or resume the run.", err);
      this.render();
    }
  }

  async #stop(): Promise<void> {
    try {
      await this.#o.api.stop();
    } catch (err) {
      this.#fail("iViz could not stop the run.", err);
      this.render();
    }
  }

  async #answer(id: string, answer: string): Promise<void> {
    try {
      await this.#o.api.answerPrompt(id, answer);
    } catch (err) {
      this.#fail("iViz could not send that answer to the robot.", err);
      this.render();
    }
  }

  /**
   * One button for both halves. The map data and the mission are two separate
   * documents on the robot, but from here it is one act: save what is unsaved.
   */
  async #saveAll(): Promise<void> {
    const { store, api } = this.#o;
    const wantSites = store.sitesDirty;
    const wantMission = store.missionDirty && store.mission !== null;
    if (!wantSites && !wantMission) return;
    this.#notice = null;

    let doc: Mission | null = null;
    if (wantMission) {
      doc = store.missionCopy();
      if (doc) {
        assignIds(doc);
        const result = validate(doc, {
          sites: store.sites,
          activeMap: store.mapName,
          missions: this.#missions.map((m) => m.name),
          connectors: this.#connectors,
          capabilities: this.#capabilities,
        });
        // A stop the graph cannot reach is not a schema error, but it is the one
        // thing this editor exists to catch, so it is reported alongside them.
        const gaps: Finding[] = planRoute(store.stops, store.points, store.lanes, store.mission)
          .filter((leg) => leg.problem !== "")
          .map((leg) => ({ level: "warning" as const, path: ["stop " + String(leg.stopIndex + 1)], message: leg.problem }));
        this.#findings = [...result.errors, ...gaps, ...result.warnings];
        if (result.errors.length) {
          const n = result.errors.length;
          const text = n === 1 ? "One thing in this mission has to be fixed before the robot will accept it. It is listed under the button." : `${n} things in this mission have to be fixed before the robot will accept it. They are listed under the button.`;
          this.#notice = { kind: "error", text };
          this.#o.toast(text);
          this.render();
          return;
        }
      }
    }

    this.#busy = true;
    this.render();
    const saved: string[] = [];
    try {
      if (wantSites) {
        await api.saveSites(store.sitesCopy());
        store.markSitesSaved();
        saved.push("the points and lanes");
      }
      if (doc) {
        await api.saveMission(doc);
        store.markMissionSaved();
        saved.push(`the mission "${doc.name}"`);
        this.#missions = await api.missions();
      }
      this.#findings = this.#findings.filter((f) => f.level !== "error");
      this.#o.toast(`Saved ${saved.join(" and ")} to the robot.`, "info");
    } catch (err) {
      if (err instanceof MissionApiError && err.errors.length) {
        this.#findings = err.errors.map((e) => ({ level: "error" as const, path: e.path ?? [], message: e.message }));
      }
      this.#fail(saved.length ? `iViz saved ${saved.join(" and ")}, but the rest did not go through.` : "iViz could not save this to the robot.", err);
    } finally {
      this.#busy = false;
      this.render();
    }
  }

  /** Turn any thrown thing into a sentence plus a foldaway detail. */
  #fail(what: string, err: unknown): void {
    const detail = detailOf(err);
    const why = reason(err);
    this.#notice = { kind: "error", text: why ? `${what} ${why}` : what, detail };
    this.#o.toast(why ? `${what} ${why}` : what);
  }

  // ---- live state ---------------------------------------------------------

  #onAvailability(ok: boolean): void {
    if (!ok) {
      this.#status = null;
      this.#missions = [];
      this.#resetRunMarks();
    } else if (this.#active) {
      void this.reload();
    }
    this.render();
  }

  #onStatus(status: RunnerStatus): void {
    const before = this.#status;
    this.#status = status;
    if (status.connectors) this.#connectors = Object.keys(status.connectors);
    const stepId = status.run?.step?.id;
    if (status.run && status.run.mission === this.#o.store.mission?.name && stepId) this.#markStep(stepId, null);
    if (!status.run) this.#activeStop = null;
    this.#pushRunState();
    // Only a change that adds or removes controls needs the panel rebuilt.
    const structural = (before?.prompt?.id ?? "") !== (status.prompt?.id ?? "") || (before?.run?.id ?? "") !== (status.run?.id ?? "") || (before?.state ?? "") !== status.state;
    if (structural) this.render();
    else this.#refreshLive();
  }

  #onEvent(ev: RunnerEvent): void {
    const mine = this.#o.store.mission?.name;
    if (!mine) return;
    if (ev.type === "run.started" && ev.run?.mission === mine) this.#resetRunMarks();
    else if (ev.type === "step.started" && ev.step_id) this.#markStep(ev.step_id, null);
    else if (ev.type === "step.finished" && ev.step_id) this.#markStep(ev.step_id, ev.result?.ok === false);
    else if (ev.type === "run.finished" && ev.run?.mission === mine) {
      if (ev.run.status === "succeeded") {
        this.#o.store.stops.forEach((_s, i) => this.#doneStops.add(i));
        this.#failedStop = null;
      }
      this.#activeStop = null;
    }
    this.#pushRunState();
    this.#refreshLive();
  }

  /** Map a runner step id onto a stop and update the marks. */
  #markStep(stepId: string, failed: boolean | null): void {
    const index = this.#stopIndexOfStep(stepId);
    if (index === null) return;
    if (failed === true) {
      this.#failedStop = index;
      return;
    }
    this.#activeStop = index;
    for (let i = 0; i < index; i++) this.#doneStops.add(i);
  }

  #stopIndexOfStep(stepId: string): number | null {
    const stops = this.#o.store.stops;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i]!.step.id === stepId) return i;
      if (stops[i]!.actions.some((a) => a.id === stepId)) return i;
    }
    return null;
  }

  #resetRunMarks(): void {
    this.#activeStop = null;
    this.#doneStops = new Set();
    this.#failedStop = null;
    this.#pushRunState();
  }

  #pushRunState(): void {
    this.#o.layer.setRunState({ activeStop: this.#activeStop, doneStops: this.#doneStops, failedStop: this.#failedStop });
  }
}

// ---- helpers -----------------------------------------------------------------

function button(iconName: IconName, label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: cls }, icon(iconName), ...(label ? [document.createTextNode(label)] : []));
  if (!label) b.classList.add("icon-only");
  b.addEventListener("click", onClick);
  return b;
}

/** A string that changes exactly when the selection changes. */
function selectionKey(sel: { kind: string; name?: string; index?: number }): string {
  return sel.kind === "point" ? `point:${sel.name ?? ""}` : sel.kind === "none" ? "none" : `${sel.kind}:${sel.index ?? -1}`;
}

/** A standalone card in the panel, outside the section rhythm. */
function card(body: (HTMLElement | string)[], cls = ""): HTMLElement {
  return h("div", { class: `panel-card ${cls}`.trim() }, ...body);
}

/** Capitalise and end with a full stop, so messages read like prose. */
function sentence(text: string): string {
  const t = text.trim();
  if (t === "") return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

/** The part of an error a person can act on, or "" when there is none. */
function reason(err: unknown): string {
  if (err instanceof MissionApiError) {
    if (err.status === 0) return "The robot did not answer.";
    if (err.status === 404) return "The robot says it does not have it.";
    if (err.status >= 500) return "Something went wrong on the robot's side.";
    return sentence(err.message);
  }
  return err instanceof Error ? sentence(err.message) : "";
}

/** Everything technical, for the Details fold. Never shown by itself. */
function detailOf(err: unknown): string {
  if (err instanceof MissionApiError) {
    const bits = [`${err.name}: ${err.message}`, `status ${err.status}`];
    for (const e of err.errors) bits.push(`${(e.path ?? []).join(" › ") || "(mission)"}: ${e.message}`);
    return bits.join("\n");
  }
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/** Drag-to-reorder for a list of rows carrying `data-index`. */
function makeReorderable(container: HTMLElement, selector: string, onMove: (from: number, to: number) => void): void {
  let dragging: number | null = null;
  container.addEventListener("dragstart", (e) => {
    const el = (e.target as HTMLElement).closest(selector) as HTMLElement | null;
    if (!el) return;
    dragging = Number(el.dataset.index);
    e.dataTransfer?.setData("text/plain", String(dragging));
    el.classList.add("dragging");
  });
  container.addEventListener("dragend", () => {
    dragging = null;
    for (const el of container.querySelectorAll(`${selector}.dragging, ${selector}.drop-target`)) el.classList.remove("dragging", "drop-target");
  });
  container.addEventListener("dragover", (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const el = (e.target as HTMLElement).closest(selector) as HTMLElement | null;
    for (const other of container.querySelectorAll(`${selector}.drop-target`)) other.classList.remove("drop-target");
    el?.classList.add("drop-target");
  });
  container.addEventListener("drop", (e) => {
    if (dragging === null) return;
    e.preventDefault();
    const el = (e.target as HTMLElement).closest(selector) as HTMLElement | null;
    if (!el) return;
    const to = Number(el.dataset.index);
    if (Number.isFinite(to) && to !== dragging) onMove(dragging, to);
    dragging = null;
  });
}
