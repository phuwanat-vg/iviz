import { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { ConnectionState } from "../net/FoxgloveConnection";
import { TfTree } from "../ros/TfTree";
import { SCHEMAS } from "../ros/schemas";
import type { TFMessage } from "../ros/types";
import { normalizeSchemaName } from "../ros/types";
import { Viewer } from "../viz/Viewer";
import type { PoseToolResult } from "../viz/Viewer";
import { TfLayer, createLayer, isSupportedSchema, shortTypeName } from "../viz/layers";
import type { Layer, SettingsValues } from "../viz/layers";
import type { SettingDef } from "../viz/layers/Layer";
import { loadSettings, saveSettings } from "../state/settings";
import { checkForUpdate, getAppVersion, installUpdateAndRestart, isDesktop } from "../updater";
import type { UpdateInfo } from "../updater";
import { icon, setButtonContent } from "./icons";
import { h, section } from "./dom";
import { MissionApi } from "../mission/MissionApi";
import { RouteStore } from "../mission/RouteStore";
import { RouteLayer } from "../viz/layers/RouteLayer";
import { RoutePanel } from "./RoutePanel";
import { NavPanel } from "./NavPanel";
import type { AppSettings, PersistedLayer } from "../state/settings";
import type { Channel, Service } from "@foxglove/ws-protocol";

interface ActiveLayer {
  layer: Layer;
  unsubscribe: () => void;
  card?: HTMLElement;
  statusEl?: HTMLElement;
}

const TF_TOPICS = new Set(["/tf", "/tf_static"]);

/**
 * Route mode is finished but parked: this release ships as a viewer, so the
 * button is greyed out. Flip this to true to bring it back — nothing else is
 * removed, and the panel, the layer and `/mission/api` still work.
 */
const ROUTE_MODE_ENABLED = false;
const ROUTE_DISABLED_REASON = "Route mode is turned off in this build";

export class App {
  readonly conn = new FoxgloveConnection();
  readonly tf = new TfTree();
  readonly viewer: Viewer;
  readonly settings: AppSettings;
  /** mission_runner over the same bridge connection; idle until it is there. */
  readonly missionApi = new MissionApi(this.conn);
  readonly routeStore = new RouteStore();

  #layers = new Map<string, ActiveLayer>();
  #tfLayer: TfLayer;
  #tfVersionSeen = -1;
  #routeLayer!: RouteLayer;
  #routePanel!: RoutePanel;
  #routeBtn!: HTMLButtonElement;
  #navBtn!: HTMLButtonElement;
  #sidebar!: HTMLElement;
  #nav!: NavPanel;

  // DOM
  #urlInput!: HTMLInputElement;
  #connectBtn!: HTMLButtonElement;
  #statusEl!: HTMLElement;
  #statsEl!: HTMLElement;
  #overlayEl!: HTMLElement;
  #hintEl!: HTMLElement;
  #toastsEl!: HTMLElement;
  #topicsEl!: HTMLElement;
  #servicesEl!: HTMLElement;
  #layersEl!: HTMLElement;
  #fixedSel!: HTMLSelectElement;
  #followSel!: HTMLSelectElement;
  #mode2dBtn!: HTMLButtonElement;
  #mode3dBtn!: HTMLButtonElement;
  #goalBtn!: HTMLButtonElement;
  #initBtn!: HTMLButtonElement;
  #hzEls = new Map<string, HTMLElement>();
  #lastToast = new Map<string, number>();

  constructor(root: HTMLElement) {
    this.settings = loadSettings();
    const viewEl = this.#buildDom(root);
    this.viewer = new Viewer(viewEl, this.tf);
    this.viewer.setMode(this.settings.mode);
    this.viewer.showGrid = this.settings.showGrid;
    this.viewer.followFrame = this.settings.followFrame;
    this.viewer.onPoseTool = (r) => this.#publishPose(r);
    this.viewer.onToolChange = (tool) => this.#syncToolUi(tool);
    if (this.settings.fixedFrame) this.viewer.setFixedFrame(this.settings.fixedFrame);

    this.#tfLayer = new TfLayer(this.settings.tfSettings);
    this.#tfLayer.visible = this.settings.showTf;
    this.viewer.addLayer(this.#tfLayer);

    this.#nav = new NavPanel({
      conn: this.conn,
      viewer: this.viewer,
      tf: this.tf,
      settings: this.settings,
      persist: () => this.#save(),
      toast: (msg, kind) => this.#toast(msg, kind),
      hide: () => this.#setNavOpen(false),
    });
    // Docked on the right of the map; the toggle in the top bar shows or hides it.
    root.appendChild(this.#nav.element);
    viewEl.appendChild(this.#nav.hud);
    this.#setNavOpen(this.settings.navOpen);

    this.#routeLayer = new RouteLayer(this.viewer, this.routeStore);
    this.#routeLayer.visible = false;
    this.viewer.addLayer(this.#routeLayer);
    this.#routePanel = new RoutePanel({
      api: this.missionApi,
      store: this.routeStore,
      viewer: this.viewer,
      layer: this.#routeLayer,
      viewEl,
      settings: this.settings,
      persist: () => this.#save(),
      toast: (msg, kind) => this.#toast(msg, kind),
      mapVisible: () => this.mapLayerVisible,
      setMapVisible: (v) => this.setMapLayerVisible(v),
    });
    root.insertBefore(this.#routePanel.element, viewEl);
    this.#routePanel.element.hidden = true;
    this.missionApi.onAvailabilityChange(() => this.#syncRouteButton());
    this.conn.onStateChange(() => this.#syncRouteButton());
    this.#syncRouteButton();
    if (ROUTE_MODE_ENABLED && this.settings.routeOpen) this.#setRouteMode(true);

    this.conn.subscribe("/tf", (msg, _ch, now) => this.tf.applyMessage(msg as TFMessage, false, now));
    this.conn.subscribe("/tf_static", (msg, _ch, now) => this.tf.applyMessage(msg as TFMessage, true, now));
    this.conn.onStateChange((s) => this.#onState(s));
    this.conn.onChannelsChange((chs) => this.#onChannels(chs));
    this.conn.onServicesChange((svcs) => this.#renderServices(svcs));
    this.conn.onError((m) => this.#toast(m));

    window.addEventListener("keydown", (e) => {
      // In Route mode Escape belongs to the Route panel (it returns to Select).
      if (e.key === "Escape" && !this.#routePanel.active) this.#setTool("none");
    });

    this.#renderLayers();
    this.#syncModeButtons();
    this.#tickTimer = setInterval(() => this.#tick(), 1000);

    if (this.settings.autoConnect && this.settings.url) this.#connect();

    void this.#initUpdater();
  }

  #tickTimer?: ReturnType<typeof setInterval>;

  /** Release the connection, render loop and timers (used by dev hot reload). */
  dispose(): void {
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    this.#routePanel.dispose();
    this.#nav.dispose();
    this.conn.autoReconnect = false;
    this.conn.disconnect();
    this.viewer.dispose();
  }

  // ----- DOM ---------------------------------------------------------------

  #buildDom(root: HTMLElement): HTMLElement {
    root.innerHTML = "";

    this.#urlInput = h("input", { class: "url-input", type: "text", value: this.settings.url, placeholder: "ws://<pi-ip>:8765" });
    this.#urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.#connect();
    });
    this.#connectBtn = h("button", { class: "primary" }, icon("plug"), "Connect");
    this.#connectBtn.addEventListener("click", () => {
      if (this.conn.state === "disconnected") this.#connect();
      else this.#disconnect();
    });
    this.#statusEl = h("div", { class: "status" }, h("span", { class: "dot" }), h("span", { class: "label", text: "Disconnected" }));
    this.#statsEl = h("div", { class: "stats", text: "" });

    this.#mode2dBtn = h("button", { title: "Top-down 2D view" }, icon("view2d"), "2D");
    this.#mode3dBtn = h("button", { title: "Orbit 3D view" }, icon("view3d"), "3D");
    this.#mode2dBtn.addEventListener("click", () => this.#setMode("2d"));
    this.#mode3dBtn.addEventListener("click", () => this.#setMode("3d"));

    this.#followSel = h("select", { title: "Follow frame" });
    this.#followSel.addEventListener("change", () => {
      this.settings.followFrame = this.#followSel.value;
      this.viewer.followFrame = this.#followSel.value;
      this.#save();
    });

    this.#goalBtn = h("button", { title: "Click and drag in the view to send a goal" }, icon("goal"), "2D Nav Goal");
    this.#initBtn = h("button", { title: "Click and drag in the view to set initial pose" }, icon("poseEstimate"), "2D Pose Estimate");
    this.#goalBtn.addEventListener("click", () => this.#setTool(this.viewer.tool === "goal" ? "none" : "goal"));
    this.#initBtn.addEventListener("click", () => this.#setTool(this.viewer.tool === "initialpose" ? "none" : "initialpose"));

    const resetBtn = h("button", { title: "Return camera to origin" }, icon("resetView"), "Reset view");
    resetBtn.addEventListener("click", () => this.viewer.resetView());

    this.#routeBtn = h("button", { title: ROUTE_MODE_ENABLED ? "Draw the route graph and build missions" : ROUTE_DISABLED_REASON }, icon("route"), "Route");
    this.#routeBtn.disabled = !ROUTE_MODE_ENABLED;
    this.#routeBtn.addEventListener("click", () => {
      if (!ROUTE_MODE_ENABLED) return;
      this.#setRouteMode(!this.#routePanel.active);
    });

    this.#navBtn = h("button", { class: "nav-toggle", title: "Show or hide the Navigation panel" }, icon("navigation"), "Navigation");
    this.#navBtn.addEventListener("click", () => this.#setNavOpen(!this.settings.navOpen));

    const topbar = h(
      "div",
      { class: "topbar" },
      h("div", { class: "brand" }, "i", h("span", { text: "Viz" })),
      this.#urlInput,
      this.#connectBtn,
      this.#statusEl,
      this.#statsEl,
      h("div", { class: "spacer" }),
      h("div", { class: "seg" }, this.#mode2dBtn, this.#mode3dBtn),
      h("label", { class: "stats", title: "Keep the camera centered on a TF frame" }, icon("follow"), "Follow"),
      this.#followSel,
      this.#goalBtn,
      this.#initBtn,
      resetBtn,
      this.#routeBtn,
      this.#navBtn,
    );

    // Sidebar
    this.#fixedSel = h("select");
    this.#fixedSel.addEventListener("change", () => {
      this.settings.fixedFrame = this.#fixedSel.value;
      this.#applyFixedFrame();
      this.#save();
    });
    const gridChk = h("input", { type: "checkbox" });
    gridChk.checked = this.settings.showGrid;
    gridChk.addEventListener("change", () => {
      this.settings.showGrid = gridChk.checked;
      this.viewer.showGrid = gridChk.checked;
      this.#save();
    });

    const viewSection = section("View", [
      h("div", { class: "row" }, h("label", { text: "Fixed frame" }), this.#fixedSel),
      h("div", { class: "row" }, h("label", { text: "Show grid" }), gridChk),
    ], false, "eye");

    this.#topicsEl = h("div", {}, h("div", { class: "empty", text: "Connect to see topics" }));
    const topicsSection = section("Topics", [this.#topicsEl], false, "topics");

    this.#servicesEl = h("div", {}, h("div", { class: "empty", text: "Connect to see services" }));
    const servicesSection = section("Services", [this.#servicesEl], true, "services");

    this.#layersEl = h("div");
    const layersSection = section("Layers", [this.#layersEl], false, "layers");

    this.#versionEl = h("span", { class: "stats", text: "…" });
    this.#updateBtn = h("button", {}, icon("refresh"), "Check for updates");
    this.#updateBtn.addEventListener("click", () => void this.#checkUpdates(true));
    this.#updateStatusEl = h("div", { class: "type", style: "color:var(--muted);font-size:11px;padding-top:4px" });
    const aboutSection = section(
      "About",
      [
        h("div", { class: "row" }, h("label", { text: "iViz version" }), this.#versionEl),
        h("div", { class: "row" }, this.#updateBtn),
        this.#updateStatusEl,
      ],
      true,
      "info",
    );

    const sidebar = h("div", { class: "sidebar" }, viewSection, topicsSection, servicesSection, layersSection, aboutSection);
    this.#sidebar = sidebar;

    // Viewer
    this.#overlayEl = h("div", { class: "overlay", text: "" });
    this.#hintEl = h("div", { class: "hint" });
    this.#hintEl.hidden = true;
    this.#toastsEl = h("div", { class: "toasts" });
    const view = h("div", { class: "view" });
    view.append(this.#overlayEl, this.#hintEl, this.#toastsEl);

    root.append(topbar, sidebar, view);
    return view;
  }

  // ----- connection --------------------------------------------------------

  #connect(): void {
    const url = this.#urlInput.value.trim();
    if (!url) return;
    this.settings.url = url;
    this.settings.autoConnect = true;
    this.#save();
    this.conn.connect(url);
  }

  #disconnect(): void {
    this.settings.autoConnect = false;
    this.#save();
    this.conn.disconnect();
  }

  #onState(s: ConnectionState): void {
    this.#statusEl.classList.remove("connected", "connecting");
    if (s !== "disconnected") this.#statusEl.classList.add(s);
    const label = this.#statusEl.querySelector(".label")!;
    label.textContent = s === "connected" ? this.#connectedLabel() : s === "connecting" ? "Connecting…" : "Disconnected";
    if (s === "disconnected") setButtonContent(this.#connectBtn, "plug", "Connect");
    else setButtonContent(this.#connectBtn, "unplug", "Disconnect");
    this.#connectBtn.classList.toggle("primary", s === "disconnected");
    if (s === "disconnected") {
      this.tf.clear();
      this.#topicsEl.replaceChildren(h("div", { class: "empty", text: this.settings.autoConnect ? "Reconnecting…" : "Connect to see topics" }));
      this.#servicesEl.replaceChildren(h("div", { class: "empty", text: this.settings.autoConnect ? "Reconnecting…" : "Connect to see services" }));
    }
  }

  #onChannels(channels: Channel[]): void {
    // Restore persisted layers whose topics just appeared.
    for (const p of this.settings.layers) {
      if (this.#layers.has(p.topic)) continue;
      const ch = channels.find((c) => c.topic === p.topic);
      if (ch && isSupportedSchema(ch.schemaName)) this.#addLayer(ch, p.settings, p.visible);
    }
    this.#renderTopics(channels);
    if (this.#routePanel.active) this.#ensureMapLayer();
    const label = this.#statusEl.querySelector(".label");
    if (label && this.conn.state === "connected") label.textContent = this.#connectedLabel();
  }

  #connectedLabel(): string {
    const name = this.conn.serverInfo?.name?.trim();
    return name ? `Connected · ${name}` : "Connected";
  }

  // ----- topics & layers ---------------------------------------------------

  #renderTopics(channels: Channel[]): void {
    this.#hzEls.clear();
    if (channels.length === 0) {
      this.#topicsEl.replaceChildren(h("div", { class: "empty", text: this.conn.state === "connected" ? "No topics advertised" : "Connect to see topics" }));
      return;
    }
    const rows: HTMLElement[] = [];
    for (const ch of channels) {
      // Action internals (include_hidden:=true) are used by Navigation, not drawn.
      if (ch.topic.includes("/_action/")) continue;
      const supported = isSupportedSchema(ch.schemaName);
      const isTf = TF_TOPICS.has(ch.topic);
      const chk = h("input", { type: "checkbox" });
      chk.checked = isTf || this.#layers.has(ch.topic);
      chk.disabled = isTf || !supported;
      chk.addEventListener("change", () => {
        if (chk.checked) this.#addLayer(ch);
        else this.#removeLayer(ch.topic);
      });
      const hz = h("span", { class: "hz", text: "" });
      this.#hzEls.set(ch.topic, hz);
      const row = h(
        "div",
        { class: `topic${supported || isTf ? "" : " unsupported"}`, title: `${ch.topic}\n${ch.schemaName}${supported || isTf ? "" : "\n(not supported yet)"}` },
        chk,
        h("div", {}, h("div", { class: "name", text: ch.topic }), h("div", { class: "type", text: shortTypeName(ch.schemaName) + (isTf ? " · auto" : "") })),
        hz,
      );
      rows.push(row);
    }
    this.#topicsEl.replaceChildren(...rows);
  }

  /** Read-only list of the services the bridge offers; calling is done in code. */
  #renderServices(services: Service[]): void {
    if (this.conn.state !== "connected") return;
    if (!this.conn.supportsServices) {
      this.#servicesEl.replaceChildren(h("div", { class: "empty", text: "This bridge does not advertise services" }));
      return;
    }
    if (services.length === 0) {
      this.#servicesEl.replaceChildren(h("div", { class: "empty", text: "No services advertised" }));
      return;
    }
    const rows = services.filter((s) => !s.name.includes("/_action/")).map((s) =>
      h(
        "div",
        { class: "topic service", title: `${s.name}\n${s.type}` },
        h("div", {}, h("div", { class: "name", text: s.name }), h("div", { class: "type", text: shortTypeName(s.type) })),
      ),
    );
    this.#servicesEl.replaceChildren(...rows);
  }

  #addLayer(ch: Channel, initial?: SettingsValues, visible = true): void {
    if (this.#layers.has(ch.topic)) return;
    const layer = createLayer(ch.topic, ch.schemaName, initial);
    if (!layer) return;
    layer.visible = visible;
    const unsubscribe = this.conn.subscribe(ch.topic, (msg, _c, now) => layer.onMessage(msg, now));
    this.viewer.addLayer(layer);
    this.#layers.set(ch.topic, { layer, unsubscribe });
    this.#upsertPersisted(layer);
    this.#renderLayers();
  }

  #removeLayer(topic: string): void {
    const a = this.#layers.get(topic);
    if (!a) return;
    a.unsubscribe();
    this.viewer.removeLayer(a.layer);
    this.#layers.delete(topic);
    this.settings.layers = this.settings.layers.filter((p) => p.topic !== topic);
    this.#save();
    this.#renderLayers();
    const chk = this.#topicsEl.querySelector<HTMLInputElement>(`input[type=checkbox]`);
    void chk;
    this.#renderTopics(this.conn.channels);
  }

  #upsertPersisted(layer: Layer): void {
    const entry: PersistedLayer = { topic: layer.topic, schemaName: layer.schemaName, visible: layer.visible, settings: { ...layer.settings } };
    const i = this.settings.layers.findIndex((p) => p.topic === layer.topic);
    if (i >= 0) this.settings.layers[i] = entry;
    else this.settings.layers.push(entry);
    this.#save();
  }

  #renderLayers(): void {
    const cards: HTMLElement[] = [];
    cards.push(this.#layerCard(this.#tfLayer, undefined));
    for (const a of this.#layers.values()) cards.push(this.#layerCard(a.layer, a));
    this.#layersEl.replaceChildren(...cards);
  }

  #layerCard(layer: Layer, active: ActiveLayer | undefined): HTMLElement {
    const isTf = layer === this.#tfLayer;
    const vis = h("input", { type: "checkbox", title: "Visible" });
    vis.checked = layer.visible;
    const card = h("div", { class: `layer collapsed${layer.visible ? "" : " hidden"}` });
    vis.addEventListener("change", () => {
      layer.visible = vis.checked;
      card.classList.toggle("hidden", !vis.checked);
      if (isTf) this.settings.showTf = vis.checked;
      else this.#upsertPersisted(layer);
      this.#save();
    });
    vis.addEventListener("click", (e) => e.stopPropagation());
    const status = h("span", { class: "status", text: layer.status });
    const caret = h("span", { class: "caret", text: "▸" });
    const head = h("div", { class: "layer-head" }, vis, h("span", { class: "name", text: isTf ? "TF" : layer.topic, title: layer.topic }), status, caret);
    if (!isTf) {
      const rm = h("button", { class: "icon icon-only danger", title: "Remove layer" }, icon("close"));
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#removeLayer(layer.topic);
      });
      head.appendChild(rm);
    }
    head.addEventListener("click", () => {
      card.classList.toggle("collapsed");
      caret.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
    });

    const body = h("div", { class: "layer-body" }, h("div", { class: "type", text: shortTypeName(layer.schemaName), style: "color:var(--muted);font-size:11px;padding-bottom:4px" }));
    for (const [key, def] of Object.entries(layer.schema)) {
      body.appendChild(this.#settingRow(layer, key, def, isTf));
    }
    if ("clearAccumulated" in layer && typeof (layer as { clearAccumulated?: unknown }).clearAccumulated === "function") {
      const btn = h("button", {}, icon("eraser"), "Clear accumulated points");
      btn.addEventListener("click", () => (layer as unknown as { clearAccumulated: () => void }).clearAccumulated());
      body.appendChild(h("div", { class: "row" }, btn));
    }
    card.append(head, body);
    if (active) {
      active.card = card;
      active.statusEl = status;
    } else {
      this.#tfStatusEl = status;
    }
    return card;
  }
  #tfStatusEl?: HTMLElement;

  #settingRow(layer: Layer, key: string, def: SettingDef, isTf: boolean): HTMLElement {
    const persist = () => {
      if (isTf) this.settings.tfSettings = { ...layer.settings };
      else this.#upsertPersisted(layer);
      this.#save();
    };
    let control: HTMLElement;
    const cur = layer.settings[key];
    switch (def.type) {
      case "number": {
        const inp = h("input", { type: "number", value: String(cur) });
        if (def.min !== undefined) inp.min = String(def.min);
        if (def.max !== undefined) inp.max = String(def.max);
        if (def.step !== undefined) inp.step = String(def.step);
        inp.addEventListener("input", () => {
          const v = parseFloat(inp.value);
          if (!Number.isFinite(v)) return;
          layer.setSetting(key, v);
          persist();
        });
        control = inp;
        break;
      }
      case "select": {
        const sel = h("select");
        for (const o of def.options) sel.appendChild(h("option", { value: o, text: o }));
        sel.value = String(cur);
        sel.addEventListener("change", () => {
          layer.setSetting(key, sel.value);
          persist();
        });
        control = sel;
        break;
      }
      case "boolean": {
        const chk = h("input", { type: "checkbox" });
        chk.checked = Boolean(cur);
        chk.addEventListener("change", () => {
          layer.setSetting(key, chk.checked);
          persist();
        });
        control = chk;
        break;
      }
      case "color": {
        const inp = h("input", { type: "color", value: String(cur) });
        inp.addEventListener("input", () => {
          layer.setSetting(key, inp.value);
          persist();
        });
        control = inp;
        break;
      }
      default: {
        const inp = h("input", { type: "text", value: String(cur) });
        inp.addEventListener("change", () => {
          layer.setSetting(key, inp.value);
          persist();
        });
        control = inp;
      }
    }
    return h("div", { class: "row" }, h("label", { text: def.label }), control);
  }

  // ----- view --------------------------------------------------------------

  #setMode(mode: "2d" | "3d"): void {
    this.viewer.setMode(mode);
    this.settings.mode = mode;
    this.#syncModeButtons();
    this.#save();
  }

  #syncModeButtons(): void {
    this.#mode2dBtn.classList.toggle("active", this.viewer.mode === "2d");
    this.#mode3dBtn.classList.toggle("active", this.viewer.mode === "3d");
  }

  #setTool(tool: "none" | "goal" | "initialpose"): void {
    this.viewer.setTool(tool);
    this.#syncToolUi(tool);
  }

  #syncToolUi(tool: string): void {
    this.#goalBtn.classList.toggle("active-tool", tool === "goal");
    this.#initBtn.classList.toggle("active-tool", tool === "initialpose");
    this.#routePanel?.onToolChanged(tool);
    this.#nav?.onToolChanged(tool);
    const navHint = this.#nav?.hintFor(tool);
    if (navHint) {
      this.#hintEl.textContent = navHint;
      this.#hintEl.hidden = false;
      return;
    }
    if (tool.startsWith("route.")) {
      // Route mode explains its own tools under the tool bar, where the text
      // does not sit on top of the map.
      this.#hintEl.hidden = true;
      return;
    }
    if (tool === "none") {
      this.#hintEl.hidden = true;
    } else {
      const frame = this.settings.poseFrame || this.viewer.fixedFrame;
      this.#hintEl.textContent = `${tool === "goal" ? "Nav goal" : "Initial pose"}: click position, drag for heading (frame: ${frame}). Esc to cancel.`;
      this.#hintEl.hidden = false;
    }
  }

  /** Show or hide the Navigation panel. The map resizes to the space left. */
  #setNavOpen(open: boolean): void {
    this.settings.navOpen = open;
    this.#nav.element.hidden = !open;
    this.#nav.element.parentElement?.classList.toggle("nav-open", open);
    this.#navBtn.classList.toggle("active", open);
    this.#save();
  }

  // ----- route mode --------------------------------------------------------

  /** Swap the sidebar for the Route panel (or back) and arm the editing tools. */
  #setRouteMode(on: boolean): void {
    this.#routePanel.setActive(on);
    this.#sidebar.hidden = on;
    this.#routePanel.element.hidden = !on;
    this.#routeBtn.classList.toggle("active", on);
    this.settings.routeOpen = on;
    this.#save();
    if (on && this.settings.mode !== "2d") this.#setMode("2d");
    if (on) this.#ensureMapLayer();
    this.#syncToolUi(String(this.viewer.tool));
  }

  /**
   * Route mode hides the topic list, so the floor plan has to be switched on
   * for the user: subscribe the robot's map the first time they open it.
   */
  #ensureMapLayer(): void {
    const grids = this.conn.channels.filter((c) => normalizeSchemaName(c.schemaName) === "nav_msgs/OccupancyGrid");
    if (grids.length === 0) return;
    const preferred = grids.find((c) => c.topic === "/map") ?? grids.find((c) => !c.topic.includes("costmap")) ?? grids[0]!;
    const existing = this.#layers.get(preferred.topic);
    if (existing) {
      existing.layer.visible = true;
      return;
    }
    if (this.#layers.size === 0) this.#addLayer(preferred);
  }

  /** The occupancy grid Route mode shows as the floor, if one is subscribed. */
  #mapLayer(): Layer | undefined {
    for (const a of this.#layers.values()) {
      if (normalizeSchemaName(a.layer.schemaName) === "nav_msgs/OccupancyGrid" && !a.layer.topic.includes("costmap")) return a.layer;
    }
    return undefined;
  }

  get mapLayerVisible(): boolean {
    return this.#mapLayer()?.visible ?? false;
  }

  setMapLayerVisible(visible: boolean): void {
    if (visible) this.#ensureMapLayer();
    const layer = this.#mapLayer();
    if (!layer) return;
    layer.visible = visible;
    this.#upsertPersisted(layer);
    this.#renderLayers();
  }

  /** Route mode needs `/mission/api`; without it the button explains why. */
  #syncRouteButton(): void {
    if (!ROUTE_MODE_ENABLED) {
      this.#routeBtn.disabled = true;
      this.#routeBtn.title = ROUTE_DISABLED_REASON;
      return;
    }
    const reason = this.missionApi.unavailableReason;
    this.#routeBtn.classList.toggle("unavailable", reason !== "");
    this.#routeBtn.title = reason === "" ? "Draw the route graph and build missions" : `Route mode is unavailable: ${reason}`;
  }

  #applyFixedFrame(): void {
    const wanted = this.settings.fixedFrame || this.tf.suggestFixedFrame() || this.viewer.fixedFrame || "map";
    this.viewer.setFixedFrame(wanted);
  }

  #refreshFrameSelects(): void {
    const frames = this.tf.frames();
    const suggested = this.tf.suggestFixedFrame();
    const fixedOpts = [h("option", { value: "", text: `auto${suggested ? ` (${suggested})` : ""}` })];
    for (const f of frames) fixedOpts.push(h("option", { value: f, text: f }));
    if (this.settings.fixedFrame && !frames.includes(this.settings.fixedFrame)) {
      fixedOpts.push(h("option", { value: this.settings.fixedFrame, text: `${this.settings.fixedFrame} (missing)` }));
    }
    this.#fixedSel.replaceChildren(...fixedOpts);
    this.#fixedSel.value = this.settings.fixedFrame;

    const followOpts = [h("option", { value: "", text: "none" })];
    for (const f of frames) followOpts.push(h("option", { value: f, text: f }));
    if (this.settings.followFrame && !frames.includes(this.settings.followFrame)) {
      followOpts.push(h("option", { value: this.settings.followFrame, text: `${this.settings.followFrame} (missing)` }));
    }
    this.#followSel.replaceChildren(...followOpts);
    this.#followSel.value = this.settings.followFrame;
  }

  #tick(): void {
    this.conn.tickStats();
    if (this.tf.version !== this.#tfVersionSeen) {
      this.#tfVersionSeen = this.tf.version;
      this.#refreshFrameSelects();
      this.#applyFixedFrame();
    }
    for (const [topic, el] of this.#hzEls) {
      const st = this.conn.topicStats(topic);
      el.textContent = st && st.hz > 0 ? `${st.hz.toFixed(st.hz < 10 ? 1 : 0)} Hz` : "";
    }
    for (const a of this.#layers.values()) {
      if (a.statusEl) a.statusEl.textContent = a.layer.status;
    }
    if (this.#tfStatusEl) this.#tfStatusEl.textContent = this.tf.frames().length ? `${this.tf.frames().length} frames` : "";
    const kb = this.conn.totalBytesPerSec / 1024;
    this.#statsEl.textContent = this.conn.state === "connected" ? `${kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB/s` : `${kb.toFixed(0)} KB/s`} · ${this.conn.totalMsgsPerSec.toFixed(0)} msg/s` : "";
    const pts = this.viewer.pointCount;
    this.#overlayEl.textContent = `${this.viewer.fps.toFixed(0)} fps · ${pts >= 1e6 ? `${(pts / 1e6).toFixed(2)}M` : pts >= 1e3 ? `${(pts / 1e3).toFixed(0)}k` : pts} pts · fixed: ${this.viewer.fixedFrame}`;
  }

  // ----- publishing --------------------------------------------------------

  #publishPose(r: PoseToolResult): void {
    // Through the NavigateToPose action when the bridge exposes it, so the
    // goal can be followed, paused and canceled; otherwise the goal topic.
    if (r.kind === "goal" && this.#nav.goTo({ x: r.x, y: r.y, yaw: r.yaw })) return;
    const frame = this.settings.poseFrame || this.viewer.fixedFrame;
    const now = Date.now();
    const stamp = { sec: Math.floor(now / 1000), nanosec: (now % 1000) * 1e6 };
    const pose = {
      position: { x: r.x, y: r.y, z: 0 },
      orientation: { x: 0, y: 0, z: Math.sin(r.yaw / 2), w: Math.cos(r.yaw / 2) },
    };
    let ok: boolean;
    if (r.kind === "goal") {
      ok = this.conn.publish(this.settings.goalTopic, "geometry_msgs/msg/PoseStamped", SCHEMAS["geometry_msgs/msg/PoseStamped"], {
        header: { stamp, frame_id: frame },
        pose,
      });
    } else {
      const covariance = new Array<number>(36).fill(0);
      covariance[0] = 0.25;
      covariance[7] = 0.25;
      covariance[35] = 0.06853891945200942;
      ok = this.conn.publish(this.settings.initialPoseTopic, "geometry_msgs/msg/PoseWithCovarianceStamped", SCHEMAS["geometry_msgs/msg/PoseWithCovarianceStamped"], {
        header: { stamp, frame_id: frame },
        pose: { pose, covariance },
      });
    }
    if (ok) {
      this.#toast(`${r.kind === "goal" ? "Goal" : "Initial pose"} sent: (${r.x.toFixed(2)}, ${r.y.toFixed(2)}) yaw ${((r.yaw * 180) / Math.PI).toFixed(0)}° in ${frame}`, "info");
    }
  }

  // ----- updates -----------------------------------------------------------

  #versionEl!: HTMLElement;
  #updateBtn!: HTMLButtonElement;
  #updateStatusEl!: HTMLElement;
  #updateBusy = false;

  async #initUpdater(): Promise<void> {
    try {
      this.#versionEl.textContent = await getAppVersion();
    } catch {
      this.#versionEl.textContent = "?";
    }
    if (!isDesktop()) {
      this.#updateBtn.disabled = true;
      this.#updateStatusEl.textContent = "Updates are only available in the desktop app.";
      return;
    }
    // Quiet check shortly after launch; only speaks up when something is new.
    setTimeout(() => void this.#checkUpdates(false), 5000);
  }

  async #checkUpdates(manual: boolean): Promise<void> {
    if (this.#updateBusy) return;
    this.#updateBusy = true;
    this.#updateBtn.disabled = true;
    this.#updateStatusEl.textContent = "Checking…";
    try {
      const info = await checkForUpdate();
      if (!info) {
        this.#updateStatusEl.textContent = `Up to date (checked ${new Date().toLocaleTimeString()})`;
        if (manual) this.#toast("iViz is up to date", "info");
        return;
      }
      this.#updateStatusEl.textContent = `Version ${info.version} available`;
      this.#offerUpdate(info);
    } catch (err) {
      const msg = `Update check failed: ${String(err)}`;
      this.#updateStatusEl.textContent = msg;
      if (manual) this.#toast(msg);
    } finally {
      this.#updateBusy = false;
      this.#updateBtn.disabled = false;
    }
  }

  #offerUpdate(info: UpdateInfo): void {
    const install = h("button", { class: "primary" }, icon("download"), "Install & restart");
    const later = h("button", {}, icon("clock"), "Later");
    const progress = h("div", { class: "type", style: "font-size:11px;padding-top:4px" });
    const card = h(
      "div",
      { class: "toast info update" },
      h("div", { text: `iViz ${info.version} is available (you have ${info.currentVersion}).` }),
      info.body ? h("div", { class: "type", style: "white-space:pre-wrap;font-size:11px;padding:4px 0", text: info.body.slice(0, 400) }) : "",
      h("div", { class: "row" }, install, later),
      progress,
    );
    later.addEventListener("click", () => card.remove());
    install.addEventListener("click", async () => {
      install.disabled = true;
      later.disabled = true;
      progress.textContent = "Downloading…";
      try {
        await installUpdateAndRestart((done, total) => {
          const mb = (done / 1048576).toFixed(1);
          progress.textContent = total ? `Downloading… ${mb} / ${(total / 1048576).toFixed(1)} MB` : `Downloading… ${mb} MB`;
        });
        progress.textContent = "Restarting…";
      } catch (err) {
        progress.textContent = `Update failed: ${String(err)}`;
        install.disabled = false;
        later.disabled = false;
      }
    });
    this.#toastsEl.appendChild(card);
  }

  // ----- misc --------------------------------------------------------------

  #toast(msg: string, kind: "error" | "info" = "error"): void {
    const now = Date.now();
    const last = this.#lastToast.get(msg) ?? 0;
    if (now - last < 4000) return;
    this.#lastToast.set(msg, now);
    const el = h("div", { class: `toast ${kind}`, text: msg });
    this.#toastsEl.appendChild(el);
    setTimeout(() => el.remove(), kind === "info" ? 3500 : 6000);
  }

  #save(): void {
    saveSettings(this.settings);
  }
}

export { normalizeSchemaName };
