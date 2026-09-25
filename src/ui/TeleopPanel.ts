/**
 * The Teleop tab: drive the robot by hand, like teleop_twist_keyboard.
 *
 * Hold an arrow on screen, or a key while keyboard control is on, and iViz
 * publishes a Twist (or TwistStamped) on the chosen topic at a steady rate.
 * Letting go sends a zero, and so does anything that could leave the robot
 * running unattended: the window losing focus, the tab being switched away,
 * or the connection dropping.
 *
 * The keys are teleop_twist_keyboard's, so they need no learning:
 *
 *   u i o      forward-left  forward  forward-right
 *   j k l      turn left     stop     turn right
 *   m , .      back-left     back     back-right
 *
 * plus the arrow keys, which combine (up + left arcs left), and the speed keys
 * q/z (both speeds), w/x (linear only) and e/c (angular only), each ±10 %.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import { SCHEMAS } from "../ros/schemas";
import type { AppSettings, TeleopSettings } from "../state/settings";
import { DEFAULT_TELEOP } from "../state/settings";
import { h, row } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";

export interface TeleopHost {
  conn: FoxgloveConnection;
  settings: AppSettings;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
}

/** Forward (+1) or back (-1), and turn left (+1) or right (-1). */
interface Motion {
  x: number;
  th: number;
}

const TWIST = "geometry_msgs/msg/Twist";
const TWIST_STAMPED = "geometry_msgs/msg/TwistStamped";

/** teleop_twist_keyboard's move keys. */
const MOVE_KEYS: Record<string, Motion> = {
  u: { x: 1, th: 1 },
  i: { x: 1, th: 0 },
  o: { x: 1, th: -1 },
  j: { x: 0, th: 1 },
  l: { x: 0, th: -1 },
  m: { x: -1, th: -1 },
  ",": { x: -1, th: 0 },
  ".": { x: -1, th: 1 },
};

const ARROWS: Record<string, Motion> = {
  ArrowUp: { x: 1, th: 0 },
  ArrowDown: { x: -1, th: 0 },
  ArrowLeft: { x: 0, th: 1 },
  ArrowRight: { x: 0, th: -1 },
};

/** teleop_twist_keyboard's speed keys: [linear factor, angular factor]. */
const SPEED_KEYS: Record<string, [number, number]> = {
  q: [1.1, 1.1],
  z: [0.9, 0.9],
  w: [1.1, 1],
  x: [0.9, 1],
  e: [1, 1.1],
  c: [1, 0.9],
};

/** The on-screen pad: key label, motion, icon and how far to turn the icon. */
const PAD: { key: string; motion: Motion; iconName: IconName; turn: number; title: string }[] = [
  { key: "u", motion: { x: 1, th: 1 }, iconName: "arrowUp", turn: -45, title: "Forward, turning left" },
  { key: "i", motion: { x: 1, th: 0 }, iconName: "arrowUp", turn: 0, title: "Forward" },
  { key: "o", motion: { x: 1, th: -1 }, iconName: "arrowUp", turn: 45, title: "Forward, turning right" },
  { key: "j", motion: { x: 0, th: 1 }, iconName: "undo", turn: 0, title: "Turn left in place" },
  { key: "k", motion: { x: 0, th: 0 }, iconName: "stop", turn: 0, title: "Stop" },
  { key: "l", motion: { x: 0, th: -1 }, iconName: "redo", turn: 0, title: "Turn right in place" },
  { key: "m", motion: { x: -1, th: -1 }, iconName: "arrowDown", turn: 45, title: "Back, toward the left" },
  { key: ",", motion: { x: -1, th: 0 }, iconName: "arrowDown", turn: 0, title: "Back" },
  { key: ".", motion: { x: -1, th: 1 }, iconName: "arrowDown", turn: -45, title: "Back, toward the right" },
];

export class TeleopPanel {
  readonly element: HTMLElement;

  #host: TeleopHost;
  #visible = false;
  /** Motion from the on-screen pad while a button is held. */
  #padMotion?: Motion;
  #padButton?: HTMLButtonElement;
  /** Keys held down while keyboard control is on. */
  #keys = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  /** The last command was not zero, so a zero is owed when it stops. */
  #moving = false;
  #lastSent = { x: 0, th: 0 };
  #sentCount = 0;
  #disposers: (() => void)[] = [];

  #padButtons = new Map<string, HTMLButtonElement>();
  #linSlider!: HTMLInputElement;
  #angSlider!: HTMLInputElement;
  #linValue!: HTMLElement;
  #angValue!: HTMLElement;
  #keyboardChk!: HTMLInputElement;
  #keyboardChip!: HTMLElement;
  #topicInput!: HTMLInputElement;
  #typeSel!: HTMLSelectElement;
  #frameInput!: HTMLInputElement;
  #stampSel!: HTMLSelectElement;
  #rateInput!: HTMLInputElement;
  #maxLin!: HTMLInputElement;
  #maxAng!: HTMLInputElement;
  #readout!: HTMLElement;
  #note!: HTMLElement;

  constructor(host: TeleopHost) {
    this.#host = host;
    this.element = this.#build();
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", this.#releaseAll);
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#disposers.push(
      host.conn.onStateChange((state) => {
        if (state !== "connected") this.#releaseAll();
        this.#render();
      }),
    );
    this.#disposers.push(host.conn.onChannelsChange(() => this.#render()));
    this.#render();
  }

  get #cfg(): TeleopSettings {
    return this.#host.settings.teleop;
  }

  /** Called by the dock: keys only drive the robot while this tab is on screen. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (!visible) this.#releaseAll();
    this.#render();
  }

  dispose(): void {
    this.#releaseAll();
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#releaseAll);
    document.removeEventListener("visibilitychange", this.#onVisibility);
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }

  // ----- building ----------------------------------------------------------

  #build(): HTMLElement {
    const cfg = this.#cfg;
    const pad = h("div", { class: "teleop-pad" });
    for (const b of PAD) {
      const glyph = icon(b.iconName, 22);
      if (b.turn) glyph.style.transform = `rotate(${b.turn}deg)`;
      const button = h("button", { class: `teleop-btn${b.key === "k" ? " stop" : ""}`, title: `${b.title} (${b.key === "," ? "comma" : b.key === "." ? "period" : b.key})` }, glyph, h("span", { class: "key", text: b.key }));
      if (b.key === "k") {
        button.addEventListener("click", () => this.stop());
      } else {
        button.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          try {
            // Keep the release even when the pointer slides off the button.
            button.setPointerCapture(e.pointerId);
          } catch {
            /* a pointer the browser does not track; pointerup still arrives */
          }
          this.#padMotion = b.motion;
          this.#padButton = button;
          this.#update();
        });
        const release = (): void => {
          if (this.#padButton !== button) return;
          this.#padMotion = undefined;
          this.#padButton = undefined;
          this.#update();
        };
        button.addEventListener("pointerup", release);
        button.addEventListener("pointercancel", release);
        button.addEventListener("lostpointercapture", release);
      }
      this.#padButtons.set(b.key, button);
      pad.appendChild(button);
    }

    this.#linSlider = h("input", { type: "range", min: "0", step: "0.01" });
    this.#angSlider = h("input", { type: "range", min: "0", step: "0.01" });
    this.#linValue = h("span", { class: "teleop-val" });
    this.#angValue = h("span", { class: "teleop-val" });
    this.#linSlider.addEventListener("input", () => this.#setSpeeds(Number(this.#linSlider.value), cfg.angular));
    this.#angSlider.addEventListener("input", () => this.#setSpeeds(cfg.linear, Number(this.#angSlider.value)));

    this.#keyboardChk = h("input", { type: "checkbox", title: "Drive with the keyboard while this tab is open" });
    this.#keyboardChk.checked = cfg.keyboard;
    this.#keyboardChk.addEventListener("change", () => {
      cfg.keyboard = this.#keyboardChk.checked;
      if (!cfg.keyboard) this.#releaseKeys();
      this.#host.persist();
      this.#render();
    });
    this.#keyboardChip = h("span", { class: "teleop-chip" });

    const text = (value: string, placeholder: string, apply: (v: string) => void): HTMLInputElement => {
      const input = h("input", { type: "text", value, placeholder });
      input.addEventListener("change", () => {
        this.stop();
        apply(input.value.trim());
        this.#host.persist();
        this.#render();
      });
      return input;
    };
    const number = (value: number, min: number, max: number, step: number, apply: (v: number) => void): HTMLInputElement => {
      const input = h("input", { type: "number", min: String(min), max: String(max), step: String(step), value: String(value) });
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) apply(Math.min(max, Math.max(min, v)));
        this.#host.persist();
        this.#render();
      });
      return input;
    };
    this.#topicInput = text(cfg.topic, DEFAULT_TELEOP.topic, (v) => (cfg.topic = v || DEFAULT_TELEOP.topic));
    this.#typeSel = h(
      "select",
      { title: "Twist for most robots and Nav2 on Jazzy; TwistStamped where the controller asks for it" },
      h("option", { value: "auto", text: "Auto (the topic's type, else Twist)" }),
      h("option", { value: "twist", text: "geometry_msgs/Twist" }),
      h("option", { value: "stamped", text: "geometry_msgs/TwistStamped" }),
    );
    this.#typeSel.value = cfg.type;
    this.#typeSel.addEventListener("change", () => {
      this.stop();
      cfg.type = this.#typeSel.value as TeleopSettings["type"];
      this.#host.persist();
      this.#render();
    });
    this.#frameInput = text(cfg.frameId, DEFAULT_TELEOP.frameId, (v) => (cfg.frameId = v || DEFAULT_TELEOP.frameId));
    this.#stampSel = h(
      "select",
      { title: "Zero lets the receiver use its own clock, so a clock difference between the PC and the robot does not matter" },
      h("option", { value: "zero", text: "Zero (receiver's clock)" }),
      h("option", { value: "pc", text: "This PC's clock" }),
    );
    this.#stampSel.value = cfg.stamp;
    this.#stampSel.addEventListener("change", () => {
      cfg.stamp = this.#stampSel.value === "pc" ? "pc" : "zero";
      this.#host.persist();
    });
    this.#rateInput = number(cfg.rateHz, 1, 50, 1, (v) => {
      cfg.rateHz = Math.round(v);
      this.#restartTimer();
    });
    this.#maxLin = number(cfg.maxLinear, 0.05, 5, 0.05, (v) => {
      cfg.maxLinear = v;
      this.#setSpeeds(cfg.linear, cfg.angular);
    });
    this.#maxAng = number(cfg.maxAngular, 0.1, 10, 0.1, (v) => {
      cfg.maxAngular = v;
      this.#setSpeeds(cfg.linear, cfg.angular);
    });

    const stopBtn = h("button", { class: "danger teleop-stop", title: "Send zero velocity now (k or Space)" }, icon("octagon"), "Stop");
    stopBtn.addEventListener("click", () => this.stop());

    this.#readout = h("div", { class: "teleop-readout" });
    this.#note = h("div", { class: "nav-note" });

    const setup = h(
      "details",
      { class: "nav-setup" },
      h("summary", { text: "Setup" }),
      row("Type", this.#typeSel),
      row("Frame (stamped)", this.#frameInput),
      row("Stamp (stamped)", this.#stampSel),
      row("Rate (Hz)", this.#rateInput),
      row("Max linear (m/s)", this.#maxLin),
      row("Max angular (rad/s)", this.#maxAng),
    );

    return h(
      "div",
      { class: "teleop-panel" },
      row("Topic", this.#topicInput),
      h("div", { class: "teleop-row" }, h("label", {}, this.#keyboardChk, " Keyboard control"), this.#keyboardChip),
      pad,
      h("div", { class: "teleop-slider" }, h("label", { text: "Linear" }), this.#linSlider, this.#linValue),
      h("div", { class: "teleop-slider" }, h("label", { text: "Angular" }), this.#angSlider, this.#angValue),
      h("div", { class: "nav-buttons" }, stopBtn),
      this.#readout,
      this.#note,
      h("div", {
        class: "nav-note",
        text: "Keys: u i o / j k l / m , . as in teleop_twist_keyboard, or the arrow keys; hold to move, let go to stop. Space or k stops. q/z change both speeds by 10 %, w/x linear only, e/c angular only.",
      }),
      setup,
    );
  }

  // ----- control -----------------------------------------------------------

  /** Stop at once: forget what is held and send a zero. */
  stop(): void {
    this.#padMotion = undefined;
    this.#padButton = undefined;
    this.#keys.clear();
    this.#moving = true; // owe a zero even if nothing looked like it was moving
    this.#update();
  }

  #setSpeeds(linear: number, angular: number): void {
    const cfg = this.#cfg;
    cfg.linear = round2(Math.min(cfg.maxLinear, Math.max(0, linear)));
    cfg.angular = round2(Math.min(cfg.maxAngular, Math.max(0, angular)));
    this.#host.persist();
    this.#render();
  }

  #releaseKeys(): void {
    if (this.#keys.size === 0) return;
    this.#keys.clear();
    this.#update();
  }

  #releaseAll = (): void => {
    if (!this.#padMotion && this.#keys.size === 0 && !this.#moving) return;
    this.#padMotion = undefined;
    this.#padButton = undefined;
    this.#keys.clear();
    this.#update();
  };

  #onVisibility = (): void => {
    if (document.hidden) this.#releaseAll();
  };

  #keyboardLive(): boolean {
    return this.#cfg.keyboard && this.#visible;
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (!this.#keyboardLive() || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === " " || key === "k") {
      e.preventDefault();
      this.stop();
      return;
    }
    if (key in SPEED_KEYS) {
      e.preventDefault();
      const [fl, fa] = SPEED_KEYS[key]!;
      this.#setSpeeds(this.#cfg.linear * fl, this.#cfg.angular * fa);
      return;
    }
    if (key in MOVE_KEYS || key in ARROWS) {
      e.preventDefault();
      if (e.repeat || this.#keys.has(key)) return;
      this.#keys.add(key);
      this.#update();
    }
  };

  #onKeyUp = (e: KeyboardEvent): void => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!this.#keys.delete(key)) return;
    this.#update();
  };

  /** What is held right now, from the pad or the keys. */
  #motion(): Motion {
    if (this.#padMotion) return this.#padMotion;
    let x = 0;
    let turn = 0;
    let arrowTurn = 0;
    for (const key of this.#keys) {
      const m = MOVE_KEYS[key];
      if (m) {
        x += m.x;
        turn += m.th;
      }
      const a = ARROWS[key];
      if (a) {
        x += a.x;
        arrowTurn += a.th;
      }
    }
    x = Math.sign(x);
    // Left while backing up curves the robot toward its rear left, as a car
    // does, which is what m and . do too.
    const th = Math.sign(turn + (x < 0 ? -arrowTurn : arrowTurn));
    return { x, th };
  }

  /** Re-read what is held; start, keep or stop publishing to match. */
  #update(): void {
    const m = this.#motion();
    const active = m.x !== 0 || m.th !== 0;
    if (active) {
      this.#send(m);
      this.#restartTimer();
    } else {
      this.#stopTimer();
      if (this.#moving) this.#send({ x: 0, th: 0 });
    }
    this.#render();
  }

  #restartTimer(): void {
    this.#stopTimer();
    const m = this.#motion();
    if (m.x === 0 && m.th === 0) return;
    this.#timer = setInterval(() => this.#send(this.#motion()), 1000 / Math.max(1, this.#cfg.rateHz));
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #send(m: Motion): void {
    const { conn } = this.#host;
    const cfg = this.#cfg;
    if (conn.state !== "connected") {
      this.#moving = false;
      return;
    }
    const vx = m.x * cfg.linear;
    const wz = m.th * cfg.angular;
    const twist = { linear: { x: vx, y: 0, z: 0 }, angular: { x: 0, y: 0, z: wz } };
    const stamped = this.#messageType() === TWIST_STAMPED;
    let ok: boolean;
    if (stamped) {
      const now = Date.now();
      const stamp = cfg.stamp === "pc" ? { sec: Math.floor(now / 1000), nanosec: (now % 1000) * 1e6 } : { sec: 0, nanosec: 0 };
      ok = conn.publish(cfg.topic, TWIST_STAMPED, SCHEMAS[TWIST_STAMPED], { header: { stamp, frame_id: cfg.frameId }, twist });
    } else {
      ok = conn.publish(cfg.topic, TWIST, SCHEMAS[TWIST], twist);
    }
    if (!ok) {
      this.#stopTimer();
      this.#padMotion = undefined;
      this.#keys.clear();
      this.#moving = false;
      return;
    }
    this.#moving = vx !== 0 || wz !== 0;
    this.#lastSent = { x: vx, th: wz };
    this.#sentCount++;
    this.#renderReadout();
  }

  /** The message type to publish: the one chosen, or the topic's own when it is already on the bridge. */
  #messageType(): string {
    const cfg = this.#cfg;
    if (cfg.type === "twist") return TWIST;
    if (cfg.type === "stamped") return TWIST_STAMPED;
    const existing = this.#host.conn.channelForTopic(cfg.topic)?.schemaName ?? "";
    return existing.replace("/msg/", "/") === "geometry_msgs/TwistStamped" ? TWIST_STAMPED : TWIST;
  }

  // ----- rendering ---------------------------------------------------------

  #render(): void {
    const cfg = this.#cfg;
    const connected = this.#host.conn.state === "connected";
    this.#linSlider.max = String(cfg.maxLinear);
    this.#angSlider.max = String(cfg.maxAngular);
    this.#linSlider.value = String(cfg.linear);
    this.#angSlider.value = String(cfg.angular);
    this.#linValue.textContent = `${cfg.linear.toFixed(2)} m/s`;
    this.#angValue.textContent = `${cfg.angular.toFixed(2)} rad/s`;

    const live = this.#keyboardLive();
    this.#keyboardChip.textContent = cfg.keyboard ? (live ? "Keys drive the robot" : "Keys paused") : "";
    this.#keyboardChip.hidden = !cfg.keyboard;
    this.#keyboardChip.classList.toggle("live", live);
    this.element.classList.toggle("keyboard", cfg.keyboard);

    const held = this.#motion();
    for (const b of PAD) {
      const button = this.#padButtons.get(b.key)!;
      button.disabled = !connected;
      const on = b.key !== "k" && held.x === b.motion.x && held.th === b.motion.th && (held.x !== 0 || held.th !== 0);
      button.classList.toggle("held", on);
    }

    const type = this.#messageType();
    const existing = this.#host.conn.channelForTopic(cfg.topic)?.schemaName;
    const mismatch = !!existing && existing.replace("/msg/", "/") !== type.replace("/msg/", "/");
    const note = !connected
      ? "Connect to drive the robot."
      : mismatch
        ? `${cfg.topic} is ${existing} on the robot, but iViz would send ${type}. Choose Auto or the same type in Setup.`
        : "Anything else publishing on this topic (Nav2's controller, a joystick) fights these commands: cancel navigation first, or put twist_mux in between.";
    this.#note.textContent = note;
    this.#note.classList.toggle("warn", connected && mismatch);
    this.#renderReadout();
  }

  #renderReadout(): void {
    const cfg = this.#cfg;
    const moving = this.#timer !== undefined;
    const type = this.#messageType().replace("geometry_msgs/msg/", "");
    this.#readout.textContent = moving
      ? `linear.x ${this.#lastSent.x.toFixed(2)} m/s · angular.z ${this.#lastSent.th.toFixed(2)} rad/s → ${cfg.topic} (${type}, ${cfg.rateHz} Hz)`
      : `Stopped · ${type} on ${cfg.topic}`;
    this.#readout.classList.toggle("moving", moving);
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
