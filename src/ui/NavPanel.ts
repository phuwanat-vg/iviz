/**
 * The Navigation panel on the right of the map and the status bar over it.
 *
 * Waypoints and a path are drafted on the map with two viewer tools, stored in
 * the settings so they survive a restart, and handed to NavController to run.
 * The same status, Pause/Resume and Cancel appear in the sidebar and in a bar
 * over the map, which only shows while something is happening.
 */

import { Matrix4, Vector3 } from "three";
import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { TfTree } from "../ros/TfTree";
import type { OccupancyGrid } from "../ros/types";
import { DEFAULT_NAV_SETTINGS } from "../state/settings";
import type { AppSettings, NavSettings } from "../state/settings";
import type { ToolPointerEvent, Viewer } from "../viz/Viewer";
import { NavOverlayLayer } from "../viz/layers/NavOverlayLayer";
import { KIND_LABEL, NavController, densifyPath, pathLength } from "../nav/NavController";
import type { NavPhase, Pose2D, TaskKind } from "../nav/NavController";
import { defaultMapName, encodeMap, saveMapFiles } from "../nav/mapExport";
import { h, row } from "./dom";
import { icon, setButtonContent } from "./icons";
import type { IconName } from "./icons";

export const TOOL_WAYPOINT = "nav.waypoint";
export const TOOL_PATH = "nav.path";

const BRIDGE_CMD = "ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 include_hidden:=true";
const MAP_SAVER_CMD = "ros2 launch nav2_map_server map_saver_server.launch.py";

const PHASE_LABEL: Record<NavPhase, string> = {
  idle: "Idle",
  starting: "Sending",
  running: "Driving",
  canceling: "Stopping",
  paused: "Paused",
  succeeded: "Done",
  canceled: "Canceled",
  aborted: "Failed",
  rejected: "Rejected",
  error: "Error",
};

const FINISHED: ReadonlySet<NavPhase> = new Set(["succeeded", "canceled", "aborted", "rejected", "error"]);

export interface NavPanelHost {
  conn: FoxgloveConnection;
  viewer: Viewer;
  tf: TfTree;
  settings: AppSettings;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
  /** Close the panel; the status bar over the map keeps working. */
  hide(): void;
}

interface StatusView {
  el: HTMLElement;
  chip: HTMLElement;
  text: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
}

type DraftList = "waypoints" | "path";

const _m = new Matrix4();
const _v = new Vector3();

export class NavPanel {
  /** The panel docked on the right of the map. */
  readonly element: HTMLElement;
  readonly hud: HTMLElement;
  readonly controller: NavController;

  #host: NavPanelHost;
  #overlay: NavOverlayLayer;
  #dragStart?: Pose2D;
  #preview?: Pose2D;
  #draftVersion = 0;
  #overlayKey = "";
  #listKey = "";
  #diagKey = "";
  #busy = new Set<"robot" | "pc">();
  #disposers: (() => void)[] = [];

  #status!: StatusView;
  #hudStatus!: StatusView;
  #pauseBtn!: HTMLButtonElement;
  #cancelBtn!: HTMLButtonElement;
  #hudPause!: HTMLButtonElement;
  #hudCancel!: HTMLButtonElement;
  #hudDismiss!: HTMLButtonElement;
  #placeBtn!: HTMLButtonElement;
  #robotPoseBtn!: HTMLButtonElement;
  #wpUndo!: HTMLButtonElement;
  #wpClear!: HTMLButtonElement;
  #wpList!: HTMLElement;
  #modeSel!: HTMLSelectElement;
  #loopChk!: HTMLInputElement;
  #startWp!: HTMLButtonElement;
  #wpNote!: HTMLElement;
  #drawBtn!: HTMLButtonElement;
  #pathUndo!: HTMLButtonElement;
  #pathClear!: HTMLButtonElement;
  #pathInfo!: HTMLElement;
  #followBtn!: HTMLButtonElement;
  #pathNote!: HTMLElement;
  #mapName!: HTMLInputElement;
  #robotSaveBtn!: HTMLButtonElement;
  #pcSaveBtn!: HTMLButtonElement;
  #mapNote!: HTMLElement;
  #diag!: HTMLElement;

  constructor(host: NavPanelHost) {
    this.#host = host;
    this.controller = new NavController({
      conn: host.conn,
      actions: () => host.settings.nav,
      robotPose: (frame) => this.#robotPose(frame),
    });
    this.#overlay = new NavOverlayLayer(host.viewer);
    host.viewer.addLayer(this.#overlay);
    host.conn.retainLatest(this.#nav.mapTopic);

    this.element = this.#buildPanel();
    this.hud = this.#buildHud();

    host.viewer.registerTool(TOOL_WAYPOINT, {
      cursor: "crosshair",
      onPointerDown: (e) => this.#waypointDown(e),
      onPointerMove: (e) => this.#waypointMove(e),
      onPointerUp: () => this.#waypointUp(),
    });
    host.viewer.registerTool(TOOL_PATH, { cursor: "crosshair", onPointerDown: (e) => this.#pathDown(e) });

    this.#disposers.push(this.controller.onChange(() => this.#render()));
    this.#disposers.push(host.conn.onServicesChange(() => this.#render()));
    this.#disposers.push(host.conn.onStateChange(() => this.#render()));
    window.addEventListener("keydown", this.#onKey);
    this.#render();
  }

  /**
   * Drive to a pose picked with 2D Nav Goal. Returns false when Nav2 actions
   * are not reachable, so the caller can publish on the goal topic instead.
   */
  goTo(pose: Pose2D): boolean {
    if (this.controller.unavailableReason("goal") !== "") return false;
    void this.#start("goal", [{ ...pose }], this.#goalFrame());
    return true;
  }

  /** Hint shown over the map while a navigation tool is active. */
  hintFor(tool: string): string | undefined {
    if (tool === TOOL_WAYPOINT) return "Waypoints: click to place, drag to set the heading. Backspace removes the last one, Esc to finish.";
    if (tool === TOOL_PATH) return "Path: click along the route. Backspace removes the last point, Esc to finish.";
    return undefined;
  }

  onToolChanged(tool: string): void {
    if (tool !== TOOL_WAYPOINT) {
      this.#dragStart = undefined;
      this.#preview = undefined;
    }
    this.#render(true);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKey);
    for (const d of this.#disposers) d();
    this.#host.viewer.unregisterTool(TOOL_WAYPOINT);
    this.#host.viewer.unregisterTool(TOOL_PATH);
    this.controller.dispose();
  }

  // ----- building ----------------------------------------------------------

  get #nav(): NavSettings {
    return this.#host.settings.nav;
  }

  #buildPanel(): HTMLElement {
    const nav = this.#nav;
    const settings = this.#host.settings;

    this.#status = statusView();
    this.#pauseBtn = h("button");
    this.#pauseBtn.addEventListener("click", () => this.#togglePause());
    this.#cancelBtn = h("button", { class: "danger", title: "Stop every Nav2 goal on the robot" }, icon("stop"), "Cancel");
    this.#cancelBtn.addEventListener("click", () => void this.controller.cancel());

    // Waypoints
    this.#placeBtn = h("button", { title: "Click on the map to place waypoints, drag to set the heading" }, icon("mapPin"), "Place");
    this.#placeBtn.addEventListener("click", () => this.#toggleTool(TOOL_WAYPOINT));
    this.#robotPoseBtn = h("button", { title: "Add a waypoint where the robot is now, facing the way it faces" }, icon("locate"), "Robot pose");
    this.#robotPoseBtn.addEventListener("click", () => this.#addRobotPose());
    this.#wpUndo = iconButton("undo", "Remove the last waypoint", () => this.#undo("waypoints"));
    this.#wpClear = iconButton("trash", "Remove all waypoints", () => this.#clear("waypoints"));
    this.#wpList = h("div", { class: "nav-list" });
    this.#modeSel = h(
      "select",
      { title: "Follow waypoints stops at each one; Navigate through poses drives past them without stopping" },
      h("option", { value: "waypoints", text: "Follow waypoints" }),
      h("option", { value: "through", text: "Navigate through poses" }),
    );
    this.#modeSel.value = nav.waypointMode;
    this.#modeSel.addEventListener("change", () => {
      nav.waypointMode = this.#modeSel.value === "through" ? "through" : "waypoints";
      this.#host.persist();
      this.#render();
    });
    this.#loopChk = h("input", { type: "checkbox", title: "Start again from the first waypoint after the last" });
    this.#loopChk.checked = nav.loop;
    this.#loopChk.addEventListener("change", () => {
      nav.loop = this.#loopChk.checked;
      this.#host.persist();
    });
    this.#startWp = h("button", { class: "primary" });
    this.#startWp.addEventListener("click", () => void this.#startWaypoints());
    this.#wpNote = h("div", { class: "nav-note" });

    // Path
    this.#drawBtn = h("button", { title: "Click on the map to add points along the path" }, icon("spline"), "Draw");
    this.#drawBtn.addEventListener("click", () => this.#toggleTool(TOOL_PATH));
    this.#pathUndo = iconButton("undo", "Remove the last point", () => this.#undo("path"));
    this.#pathClear = iconButton("trash", "Remove the path", () => this.#clear("path"));
    this.#pathInfo = h("div", { class: "nav-note" });
    this.#followBtn = h("button", { class: "primary", title: "The controller follows this path exactly, without the planner" }, icon("play"), "Follow path");
    this.#followBtn.addEventListener("click", () => void this.#followPath());
    this.#pathNote = h("div", { class: "nav-note" });

    // Map
    this.#mapName = h("input", {
      type: "text",
      value: defaultMapName(),
      title: "On the robot a relative name is saved where map_saver runs; an absolute path such as /home/pi/maps/office is safer",
    });
    this.#robotSaveBtn = h("button", { title: "Ask the robot's map saver to write the map on the robot" }, icon("bot"), "Save on robot");
    this.#robotSaveBtn.addEventListener("click", () => void this.#saveOnRobot());
    this.#pcSaveBtn = h("button", { title: "Write the current map as .yaml + .pgm on this computer" }, icon("download"), "Save to this PC");
    this.#pcSaveBtn.addEventListener("click", () => void this.#saveToPc());
    this.#mapNote = h("div", { class: "nav-note" });

    // Setup
    const text = (value: string, placeholder: string, apply: (v: string) => void, after?: () => void): HTMLInputElement => {
      const input = h("input", { type: "text", value, placeholder });
      input.addEventListener("change", () => {
        apply(input.value.trim());
        this.#host.persist();
        after?.();
        this.#render(true);
      });
      return input;
    };
    const refreshActions = () => this.controller.refreshActions();
    this.#diag = h("div");
    const setup = h(
      "details",
      { class: "nav-setup" },
      h("summary", { text: "Setup" }),
      row("Goal frame", text(settings.poseFrame, "(fixed frame)", (v) => (settings.poseFrame = v))),
      row("Robot frame", text(nav.robotFrame, DEFAULT_NAV_SETTINGS.robotFrame, (v) => (nav.robotFrame = v || DEFAULT_NAV_SETTINGS.robotFrame))),
      row(
        "Map topic",
        text(nav.mapTopic, DEFAULT_NAV_SETTINGS.mapTopic, (v) => {
          nav.mapTopic = v || DEFAULT_NAV_SETTINGS.mapTopic;
          this.#host.conn.retainLatest(nav.mapTopic);
        }),
      ),
      row("Goal topic", text(settings.goalTopic, "/goal_pose", (v) => (settings.goalTopic = v || "/goal_pose"))),
      row("Initial pose topic", text(settings.initialPoseTopic, "/initialpose", (v) => (settings.initialPoseTopic = v || "/initialpose"))),
      h("div", { class: "nav-note", text: "The goal topic is used for 2D Nav Goal when Nav2 actions are not reachable." }),
      h("div", { class: "nav-sub", text: "Nav2 names" }),
      row("NavigateToPose", text(nav.navigateToPose, DEFAULT_NAV_SETTINGS.navigateToPose, (v) => (nav.navigateToPose = v || DEFAULT_NAV_SETTINGS.navigateToPose), refreshActions)),
      row("FollowWaypoints", text(nav.followWaypoints, DEFAULT_NAV_SETTINGS.followWaypoints, (v) => (nav.followWaypoints = v || DEFAULT_NAV_SETTINGS.followWaypoints), refreshActions)),
      row(
        "NavigateThroughPoses",
        text(nav.navigateThroughPoses, DEFAULT_NAV_SETTINGS.navigateThroughPoses, (v) => (nav.navigateThroughPoses = v || DEFAULT_NAV_SETTINGS.navigateThroughPoses), refreshActions),
      ),
      row("FollowPath", text(nav.followPath, DEFAULT_NAV_SETTINGS.followPath, (v) => (nav.followPath = v || DEFAULT_NAV_SETTINGS.followPath), refreshActions)),
      row("Controller", text(nav.controllerId, DEFAULT_NAV_SETTINGS.controllerId, (v) => (nav.controllerId = v))),
      row("Goal checker", text(nav.goalCheckerId, DEFAULT_NAV_SETTINGS.goalCheckerId, (v) => (nav.goalCheckerId = v))),
      row("Progress checker", text(nav.progressCheckerId, DEFAULT_NAV_SETTINGS.progressCheckerId, (v) => (nav.progressCheckerId = v))),
      this.#diag,
    );

    const body = h(
      "div",
      { class: "nav-panel" },
      this.#status.el,
      h("div", { class: "nav-buttons" }, this.#pauseBtn, this.#cancelBtn),
      subHeader("Waypoints", "waypoints"),
      h("div", { class: "nav-buttons" }, this.#placeBtn, this.#robotPoseBtn, this.#wpUndo, this.#wpClear),
      this.#wpList,
      row("Mode", this.#modeSel),
      row("Loop", this.#loopChk),
      h("div", { class: "nav-buttons" }, this.#startWp),
      this.#wpNote,
      subHeader("Path", "spline"),
      h("div", { class: "nav-buttons" }, this.#drawBtn, this.#pathUndo, this.#pathClear),
      this.#pathInfo,
      h("div", { class: "nav-buttons" }, this.#followBtn),
      this.#pathNote,
      subHeader("Map", "map"),
      row("Name", this.#mapName),
      h("div", { class: "nav-buttons" }, this.#robotSaveBtn, this.#pcSaveBtn),
      this.#mapNote,
      setup,
    );
    const header = h(
      "div",
      { class: "nav-dock-head" },
      icon("navigation"),
      h("span", { class: "title", text: "Navigation" }),
      iconButton("close", "Hide the Navigation panel", () => this.#host.hide()),
    );
    return h("aside", { class: "nav-dock" }, header, h("div", { class: "nav-dock-body" }, body));
  }

  #buildHud(): HTMLElement {
    this.#hudStatus = statusView();
    this.#hudPause = h("button");
    this.#hudPause.addEventListener("click", () => this.#togglePause());
    this.#hudCancel = h("button", { class: "danger", title: "Stop every Nav2 goal on the robot" }, icon("stop"), "Cancel");
    this.#hudCancel.addEventListener("click", () => void this.controller.cancel());
    this.#hudDismiss = iconButton("close", "Hide", () => this.controller.dismiss());
    const hud = h("div", { class: "nav-hud" }, this.#hudStatus.chip, this.#hudStatus.text, this.#hudPause, this.#hudCancel, this.#hudDismiss);
    hud.hidden = true;
    return hud;
  }

  // ----- rendering ---------------------------------------------------------

  #render(force = false): void {
    const c = this.controller;
    const nav = this.#nav;
    const conn = this.#host.conn;
    const viewer = this.#host.viewer;
    const connected = conn.state === "connected";

    const s = this.#statusModel();
    for (const v of [this.#status, this.#hudStatus]) {
      v.chip.className = `nav-chip ${s.cls}`;
      v.chip.textContent = s.label;
      v.title.textContent = s.title;
      v.detail.textContent = s.detail;
      v.detail.hidden = s.detail === "";
    }
    for (const b of [this.#pauseBtn, this.#hudPause]) {
      if (c.canResume) {
        setButtonContent(b, "play", "Resume");
        b.classList.add("primary");
        b.disabled = false;
        b.title = "Continue from where the robot stopped";
      } else {
        setButtonContent(b, "pause", "Pause");
        b.classList.remove("primary");
        b.disabled = !c.canPause;
        b.title = c.canPause
          ? "Stop the robot and keep the task, to resume later"
          : c.foreignGoals > 0
            ? "Pause works for tasks started from iViz; Cancel stops other goals"
            : "Nothing to pause";
      }
    }
    for (const b of [this.#cancelBtn, this.#hudCancel]) b.disabled = !c.canCancel;
    this.#hudDismiss.hidden = !FINISHED.has(c.phase);
    this.hud.hidden = c.phase === "idle" && c.foreignGoals === 0;

    // Waypoints
    const wpKind: TaskKind = nav.waypointMode === "through" ? "through" : "waypoints";
    const wpReason = c.unavailableReason(wpKind);
    const nWp = nav.waypoints.length;
    this.#robotPoseBtn.disabled = !connected;
    this.#wpUndo.disabled = nWp === 0;
    this.#wpClear.disabled = nWp === 0;
    this.#loopChk.disabled = wpKind === "through";
    setButtonContent(this.#startWp, "play", nWp > 0 ? `Start ${nWp} waypoint${nWp === 1 ? "" : "s"}` : "Start");
    this.#startWp.disabled = nWp === 0 || wpReason !== "";
    setNote(this.#wpNote, connected && wpReason ? wpReason : nWp === 0 ? "Press Place, then click on the map." : "", connected && wpReason !== "");
    this.#placeBtn.classList.toggle("active-tool", viewer.tool === TOOL_WAYPOINT);
    this.#renderList();

    // Path
    const pathReason = c.unavailableReason("path");
    const nPath = nav.path.length;
    this.#pathUndo.disabled = nPath === 0;
    this.#pathClear.disabled = nPath === 0;
    this.#pathInfo.textContent = nPath > 0 ? `${nPath} point${nPath === 1 ? "" : "s"} · ${pathLength(nav.path).toFixed(1)} m` : "Press Draw, then click along the route.";
    this.#followBtn.disabled = nPath < 2 || pathReason !== "";
    setNote(this.#pathNote, connected ? pathReason : "", connected && pathReason !== "");
    this.#drawBtn.classList.toggle("active-tool", viewer.tool === TOOL_PATH);

    // Map
    const saver = this.#saver();
    this.#robotSaveBtn.disabled = !connected || !saver || this.#busy.has("robot");
    this.#pcSaveBtn.disabled = (!connected && !conn.latest(nav.mapTopic)) || this.#busy.has("pc");
    setNote(
      this.#mapNote,
      !connected ? "" : saver ? `The robot saves through ${saver.name}.` : "No map saver on the robot, so only Save to this PC works. See Setup.",
      connected && !saver,
    );

    this.#renderDiag();
    this.#pushOverlay(force);
  }

  #statusModel(): { cls: string; label: string; title: string; detail: string } {
    const c = this.controller;
    const task = c.task;
    const p = c.progress;
    if (c.phase === "idle") {
      const n = c.foreignGoals;
      if (n > 0) return { cls: "running", label: "Busy", title: `${n} Nav2 goal${n === 1 ? "" : "s"} from another client`, detail: "Cancel stops them" };
      const reason = this.#host.conn.state !== "connected" ? "Not connected" : c.unavailableReason("goal");
      return { cls: "", label: "Idle", title: reason || "Ready", detail: "" };
    }
    const title = task ? `${KIND_LABEL[task.kind]}${c.message ? ` · ${c.message}` : ""}` : c.message;
    const parts: string[] = [];
    if (task && (task.kind === "waypoints" || task.kind === "through")) parts.push(`${p.index + 1}/${task.poses.length}`);
    if (task?.kind === "waypoints" && task.loop) parts.push(`lap ${p.lap + 1}`);
    if (c.active) {
      if (p.distanceRemaining !== undefined) parts.push(`${p.distanceRemaining.toFixed(1)} m left`);
      if (p.etaSec !== undefined && p.etaSec > 0) parts.push(`ETA ${formatDuration(p.etaSec)}`);
      if (p.speed !== undefined) parts.push(`${p.speed.toFixed(2)} m/s`);
    }
    if (p.recoveries) parts.push(`${p.recoveries} recover${p.recoveries === 1 ? "y" : "ies"}`);
    if (c.foreignGoals > 0) parts.push(`+${c.foreignGoals} other goal${c.foreignGoals === 1 ? "" : "s"}`);
    return { cls: c.phase, label: PHASE_LABEL[c.phase], title, detail: parts.join(" · ") };
  }

  #renderList(): void {
    const nav = this.#nav;
    const c = this.controller;
    const task = c.task;
    const tracking = !!task && (task.kind === "waypoints" || task.kind === "through") && (c.active || c.phase === "paused") && task.poses.length === nav.waypoints.length;
    const key = `${this.#draftVersion}|${tracking ? c.progress.index : -1}`;
    if (key === this.#listKey) return;
    this.#listKey = key;
    this.#wpList.hidden = nav.waypoints.length === 0;
    const last = nav.waypoints.length - 1;
    const rows = nav.waypoints.map((p, i) => {
      const up = iconButton("arrowUp", "Move up", () => this.#move(i, -1));
      const down = iconButton("arrowDown", "Move down", () => this.#move(i, 1));
      const del = iconButton("trash", "Remove", () => this.#remove(i));
      up.disabled = i === 0;
      down.disabled = i === last;
      const state = tracking ? (i < c.progress.index ? " done" : i === c.progress.index ? " current" : "") : "";
      return h(
        "div",
        { class: `nav-wp${state}` },
        h("span", { class: "num", text: String(i + 1) }),
        h("span", { text: `${p.x.toFixed(2)}, ${p.y.toFixed(2)}  ${Math.round((p.yaw * 180) / Math.PI)}°` }),
        h("span", { class: "acts" }, up, down, del),
      );
    });
    this.#wpList.replaceChildren(...rows);
  }

  #renderDiag(): void {
    const conn = this.#host.conn;
    const c = this.controller;
    const kinds: TaskKind[] = ["goal", "waypoints", "through", "path"];
    const reasons = kinds.map((k) => c.unavailableReason(k));
    const saver = this.#saver();
    const key = `${conn.state}|${reasons.join("|")}|${kinds.map((k) => c.actionName(k)).join("|")}|${saver?.name ?? ""}`;
    if (key === this.#diagKey) return;
    this.#diagKey = key;
    if (conn.state !== "connected") {
      this.#diag.replaceChildren();
      return;
    }
    const children: HTMLElement[] = [h("div", { class: "nav-sub", text: "On the robot" })];
    kinds.forEach((k, i) => {
      const reason = reasons[i]!;
      children.push(h("div", { class: `nav-note${reason ? " warn" : ""}` }, icon(reason ? "xCircle" : "checkCircle"), ` ${c.actionName(k)}`));
    });
    children.push(h("div", { class: `nav-note${saver ? "" : " warn"}` }, icon(saver ? "checkCircle" : "xCircle"), ` ${saver?.name ?? "map saver"}`));
    if (!conn.services.some((s) => s.name.includes("/_action/"))) {
      children.push(
        h("div", { class: "nav-note", text: "Nav2 actions travel as hidden services. Restart foxglove_bridge on the robot with:" }),
        h("div", { class: "nav-cmd", text: BRIDGE_CMD }),
      );
    }
    if (!saver) {
      children.push(h("div", { class: "nav-note", text: "To save maps on the robot, start a map saver there:" }), h("div", { class: "nav-cmd", text: MAP_SAVER_CMD }));
    }
    this.#diag.replaceChildren(...children);
  }

  #pushOverlay(force: boolean): void {
    const c = this.controller;
    const task = c.task;
    const nav = this.#nav;
    const showActive = !!task && (c.active || c.phase === "paused");
    const preview = this.#preview ? `${this.#preview.x},${this.#preview.y},${this.#preview.yaw}` : "";
    const key = `${this.#draftVersion}|${nav.draftFrame}|${preview}|${showActive ? `${c.phase}|${c.progress.index}|${task!.poses.length}` : ""}`;
    if (!force && key === this.#overlayKey) return;
    this.#overlayKey = key;
    this.#overlay.setState({
      frame: nav.draftFrame,
      waypoints: nav.waypoints,
      path: nav.path,
      preview: this.#preview,
      active: showActive && task ? { kind: task.kind, frame: task.frame, poses: task.poses, index: c.progress.index, running: c.active } : undefined,
    });
  }

  // ----- tasks -------------------------------------------------------------

  async #startWaypoints(): Promise<void> {
    const nav = this.#nav;
    if (nav.waypoints.length === 0) return;
    await this.#start(nav.waypointMode === "through" ? "through" : "waypoints", nav.waypoints.map((p) => ({ ...p })), nav.draftFrame || this.#goalFrame());
  }

  async #followPath(): Promise<void> {
    const nav = this.#nav;
    if (nav.path.length < 2) return;
    await this.#start("path", densifyPath(nav.path), nav.draftFrame || this.#goalFrame());
  }

  async #start(kind: TaskKind, poses: Pose2D[], frame: string): Promise<void> {
    const viewer = this.#host.viewer;
    if (viewer.tool === TOOL_WAYPOINT || viewer.tool === TOOL_PATH) viewer.setTool("none");
    const nav = this.#nav;
    try {
      await this.controller.start({
        kind,
        frame,
        poses,
        loop: kind === "waypoints" && nav.loop,
        controllerId: nav.controllerId,
        goalCheckerId: nav.goalCheckerId,
        progressCheckerId: nav.progressCheckerId,
      });
    } catch (err) {
      this.#host.toast(errorMessage(err));
    }
  }

  #togglePause(): void {
    const c = this.controller;
    if (c.canResume) void c.resume();
    else c.pause();
  }

  // ----- drafting ----------------------------------------------------------

  #toggleTool(name: string): void {
    const viewer = this.#host.viewer;
    viewer.setTool(viewer.tool === name ? "none" : name);
  }

  #waypointDown(ev: ToolPointerEvent): void {
    const p = ev.world ? this.#toDraft(ev.world.x, ev.world.y) : undefined;
    if (!p) return;
    const prev = this.#nav.waypoints[this.#nav.waypoints.length - 1];
    const yaw = prev ? Math.atan2(p.y - prev.y, p.x - prev.x) : 0;
    this.#dragStart = { x: p.x, y: p.y, yaw };
    this.#preview = { ...this.#dragStart };
    this.#pushOverlay(true);
  }

  #waypointMove(ev: ToolPointerEvent): void {
    const start = this.#dragStart;
    if (!start || !ev.world) return;
    const p = this.#toDraft(ev.world.x, ev.world.y);
    if (!p) return;
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (Math.hypot(dx, dy) < 0.1) return;
    this.#preview = { ...start, yaw: Math.atan2(dy, dx) };
    this.#pushOverlay(true);
  }

  #waypointUp(): void {
    const p = this.#preview;
    this.#dragStart = undefined;
    this.#preview = undefined;
    if (!p) return;
    this.#editDraft(() => this.#nav.waypoints.push(p));
  }

  #pathDown(ev: ToolPointerEvent): void {
    const p = ev.world ? this.#toDraft(ev.world.x, ev.world.y) : undefined;
    if (!p) return;
    const path = this.#nav.path;
    const prev = path[path.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.05) return;
    const yaw = prev ? Math.atan2(p.y - prev.y, p.x - prev.x) : 0;
    this.#editDraft(() => path.push({ x: p.x, y: p.y, yaw }));
  }

  /** Append the robot's current position and heading as a waypoint. */
  #addRobotPose(): void {
    const nav = this.#nav;
    const empty = nav.waypoints.length === 0 && nav.path.length === 0;
    const frame = empty ? this.#goalFrame() : nav.draftFrame || this.#goalFrame();
    const pose = this.#robotPose(frame);
    if (!pose) {
      this.#host.toast(`The robot's position is not known: no transform from ${nav.robotFrame} to ${frame}. Check Robot frame in Setup.`);
      return;
    }
    if (empty) nav.draftFrame = frame;
    this.#editDraft(() => nav.waypoints.push(pose));
  }

  #undo(list: DraftList): void {
    if (this.#nav[list].length === 0) return;
    this.#editDraft(() => this.#nav[list].pop());
  }

  #clear(list: DraftList): void {
    if (this.#nav[list].length === 0) return;
    this.#editDraft(() => (this.#nav[list] = []));
  }

  #move(i: number, delta: number): void {
    const list = this.#nav.waypoints;
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    this.#editDraft(() => ([list[i], list[j]] = [list[j]!, list[i]!]));
  }

  #remove(i: number): void {
    this.#editDraft(() => this.#nav.waypoints.splice(i, 1));
  }

  #editDraft(change: () => void): void {
    change();
    const nav = this.#nav;
    if (nav.waypoints.length === 0 && nav.path.length === 0) nav.draftFrame = "";
    this.#draftVersion++;
    this.#host.persist();
    this.#render();
  }

  #onKey = (e: KeyboardEvent): void => {
    const tool = this.#host.viewer.tool;
    if (tool !== TOOL_WAYPOINT && tool !== TOOL_PATH) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
    if (e.key === "Backspace" || e.key === "Delete" || (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this.#undo(tool === TOOL_WAYPOINT ? "waypoints" : "path");
    }
  };

  /** A point clicked in the fixed frame, expressed in the draft's frame. */
  #toDraft(x: number, y: number): Pose2D | undefined {
    const nav = this.#nav;
    if (nav.waypoints.length === 0 && nav.path.length === 0) nav.draftFrame = this.#goalFrame();
    const frame = nav.draftFrame || this.#goalFrame();
    if (!this.#host.tf.lookup(frame, this.#host.viewer.fixedFrame, _m)) {
      this.#host.toast(`Cannot place points: no transform from ${this.#host.viewer.fixedFrame} to ${frame}`);
      return undefined;
    }
    _v.set(x, y, 0).applyMatrix4(_m);
    return { x: _v.x, y: _v.y, yaw: 0 };
  }

  #goalFrame(): string {
    return this.#host.settings.poseFrame || this.#host.viewer.fixedFrame;
  }

  #robotPose(frame: string): Pose2D | undefined {
    if (!this.#host.tf.lookup(frame, this.#nav.robotFrame, _m)) return undefined;
    const e = _m.elements;
    return { x: e[12]!, y: e[13]!, yaw: Math.atan2(e[1]!, e[0]!) };
  }

  // ----- maps --------------------------------------------------------------

  #saver(): { name: string; kind: "nav2" | "slam" } | undefined {
    const services = this.#host.conn.services;
    const nav2 = services.find((s) => s.type === "nav2_msgs/srv/SaveMap");
    if (nav2) return { name: nav2.name, kind: "nav2" };
    const slam = services.find((s) => s.type === "slam_toolbox/srv/SaveMap");
    if (slam) return { name: slam.name, kind: "slam" };
    return undefined;
  }

  async #saveOnRobot(): Promise<void> {
    const saver = this.#saver();
    const name = this.#mapName.value.trim();
    const { conn, toast } = this.#host;
    if (!saver) return;
    if (!name) {
      toast("Enter a name for the map");
      return;
    }
    this.#busy.add("robot");
    this.#render();
    try {
      let ok: boolean;
      if (saver.kind === "nav2") {
        const res = await conn.callService<{ result: boolean }>(
          saver.name,
          { map_topic: this.#nav.mapTopic, map_url: name, image_format: "pgm", map_mode: "trinary", free_thresh: 0.25, occupied_thresh: 0.65 },
          60000,
        );
        ok = res.result === true;
      } else {
        const res = await conn.callService<{ result: number }>(saver.name, { name: { data: name } }, 60000);
        ok = res.result === 0;
      }
      if (ok) {
        toast(`Map saved on the robot as ${name}`, "info");
        this.#mapName.value = defaultMapName();
      } else {
        toast(`The robot could not save the map (${saver.name} reported a failure)`);
      }
    } catch (err) {
      toast(`Saving the map on the robot failed: ${errorMessage(err)}`);
    } finally {
      this.#busy.delete("robot");
      this.#render();
    }
  }

  async #saveToPc(): Promise<void> {
    const { toast } = this.#host;
    this.#busy.add("pc");
    this.#render();
    try {
      const grid = await this.#latestMap();
      const typed = this.#mapName.value.trim().split(/[\\/]/).pop() ?? "";
      const base = typed.replace(/\.(ya?ml|pgm)$/i, "") || defaultMapName();
      const path = await saveMapFiles(encodeMap(grid, base));
      if (path) toast(`Map saved: ${path}`, "info");
    } catch (err) {
      toast(`Saving the map failed: ${errorMessage(err)}`);
    } finally {
      this.#busy.delete("pc");
      this.#render();
    }
  }

  #latestMap(): Promise<OccupancyGrid> {
    const conn = this.#host.conn;
    const topic = this.#nav.mapTopic;
    const cached = conn.latest<OccupancyGrid>(topic);
    if (cached) return Promise.resolve(cached);
    if (conn.state !== "connected") return Promise.reject(new Error("Not connected"));
    if (!conn.channelForTopic(topic)) return Promise.reject(new Error(`The robot does not publish ${topic}`));
    return new Promise((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`No map arrived on ${topic} within 8 s`));
      }, 8000);
      unsubscribe = conn.subscribe(topic, (msg) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(msg as OccupancyGrid);
      });
    });
  }
}

// ---------------------------------------------------------------------------

function statusView(): StatusView {
  const chip = h("span", { class: "nav-chip" });
  const title = h("div");
  const detail = h("div", { class: "detail" });
  const text = h("div", { class: "text" }, title, detail);
  return { el: h("div", { class: "nav-status" }, chip, text), chip, text, title, detail };
}

function subHeader(label: string, iconName: IconName): HTMLElement {
  return h("div", { class: "nav-sub" }, icon(iconName), label);
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: "icon-only", title }, icon(name));
  b.addEventListener("click", onClick);
  return b;
}

function setNote(el: HTMLElement, text: string, warn: boolean): void {
  el.textContent = text;
  el.hidden = text === "";
  el.classList.toggle("warn", warn);
}

function formatDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
