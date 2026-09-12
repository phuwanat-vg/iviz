/**
 * The Dashboard tab: answer what the robot asks, and press the buttons pinned
 * from the Services tab.
 *
 * A bridge client cannot serve ROS services, so the robot cannot call iViz
 * directly. mission_runner does the waiting on the robot instead: its
 * `ask_user` step publishes the question on `/mission/event` and blocks until
 * an answer arrives, either through its `/mission/answer` service
 * (`mission_msgs/srv/Answer`) or through the `/mission/api` tunnel. The
 * buttons here send exactly that, so the step continues with the answer.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { MissionApi, Prompt, RunnerEvent } from "../mission/MissionApi";
import type { AppSettings, ServicePin } from "../state/settings";
import { h } from "./dom";
import { icon } from "./icons";
import { pretty } from "./ServicePanel";

const ANSWER_SERVICE = "/mission/answer";

export interface DashboardHost {
  conn: FoxgloveConnection;
  settings: AppSettings;
  missionApi: MissionApi;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
}

interface Answered {
  text: string;
  answer: string;
  by: string;
  at: number;
}

export class DashboardPanel {
  readonly element: HTMLElement;
  /** The same question, floating over the map so it is not missed. */
  readonly card: HTMLElement;

  #host: DashboardHost;
  #prompt?: Prompt;
  #answering = "";
  #history: Answered[] = [];
  #texts = new Map<string, string>();
  #pinsEl: HTMLElement;
  #promptEl: HTMLElement;
  #historyEl: HTMLElement;
  #noteEl: HTMLElement;
  #disposers: (() => void)[] = [];
  #timer?: ReturnType<typeof setInterval>;

  constructor(host: DashboardHost) {
    this.#host = host;
    this.#promptEl = h("div", { class: "dash-prompt" });
    this.#pinsEl = h("div", { class: "dash-pins" });
    this.#historyEl = h("div", { class: "dash-history" });
    this.#noteEl = h("div", { class: "nav-note" });
    this.element = h(
      "div",
      { class: "dash-panel" },
      h("div", { class: "nav-sub" }, icon("bot"), "Asked by the robot"),
      this.#promptEl,
      this.#noteEl,
      this.#historyEl,
      h("div", { class: "nav-sub" }, icon("services"), "Buttons"),
      this.#pinsEl,
    );
    this.card = h("div", { class: "prompt-card" });
    this.card.hidden = true;

    // Questions arrive on the runner's live stream, with or without Route mode.
    host.missionApi.startLiveState();
    this.#disposers.push(
      host.missionApi.onStatus((status) => {
        if (status.prompt) this.#remember(status.prompt);
        this.#prompt = status.prompt ?? undefined;
        this.#render();
      }),
    );
    this.#disposers.push(host.missionApi.onEvent((event) => this.#onEvent(event)));
    this.#disposers.push(host.missionApi.onAvailabilityChange(() => void this.#pullCurrent()));
    this.#disposers.push(host.conn.onStateChange(() => this.#render()));
    // The countdown of an expiring question. Only the question is redrawn, so
    // the buttons and their results are left alone.
    this.#timer = setInterval(() => {
      if (this.#prompt?.expires_at) this.#renderPrompt();
    }, 1000);
    void this.#pullCurrent();
    this.#render();
  }

  /** Redraw the pinned buttons, e.g. after one was added in the Services tab. */
  refresh(): void {
    this.#render();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }

  // ----- prompts -----------------------------------------------------------

  #onEvent(event: RunnerEvent): void {
    if (event.type === "prompt" && event.prompt) {
      const same = this.#prompt?.id === event.prompt.id;
      this.#remember(event.prompt);
      this.#prompt = event.prompt;
      // The runner repeats the pending question; redraw only what changed.
      if (!same) this.#renderPrompt();
      return;
    }
    if (event.type === "prompt.answered") {
      // `prompt.answered` carries prompt_id / answer / by, which the shared
      // event type does not spell out.
      const fields = event as unknown as Record<string, unknown>;
      const id = typeof fields.prompt_id === "string" ? fields.prompt_id : this.#prompt?.id;
      const answer = typeof fields.answer === "string" ? fields.answer : "(canceled)";
      const by = typeof fields.by === "string" ? fields.by : "";
      this.#record({ text: (id && this.#texts.get(id)) || "question", answer, by, at: Date.now() });
      if (!id || id === this.#prompt?.id) this.#prompt = undefined;
      this.#renderPrompt();
      this.#renderHistory();
    }
  }

  #remember(prompt: Prompt): void {
    this.#texts.set(prompt.id, prompt.text);
  }

  /**
   * Keep the list of answers. An answer sent from here is listed at once and
   * the runner's `prompt.answered` event confirms it a moment later, so the
   * same answer is updated rather than listed twice.
   */
  #record(entry: Answered): void {
    const recent = this.#history[0];
    if (recent && recent.answer === entry.answer && recent.text === entry.text && entry.at - recent.at < 5000) {
      this.#history[0] = { ...entry, by: entry.by || recent.by };
      return;
    }
    this.#history.unshift(entry);
    this.#history = this.#history.slice(0, 8);
  }

  /** A question raised before iViz connected is still pending on the robot. */
  async #pullCurrent(): Promise<void> {
    if (this.#host.missionApi.unavailableReason !== "") return;
    try {
      const prompt = await this.#host.missionApi.get<Prompt | null>("/api/prompt");
      if (prompt && prompt.id) {
        this.#remember(prompt);
        this.#prompt = prompt;
      }
    } catch {
      /* the runner may be busy; the event stream still delivers questions */
    }
    this.#render();
  }

  async #answer(option: string): Promise<void> {
    const prompt = this.#prompt;
    if (!prompt || this.#answering) return;
    this.#answering = option;
    this.#render();
    const { conn, missionApi, toast } = this.#host;
    try {
      if (conn.hasService(ANSWER_SERVICE)) {
        const result = await conn.callService<{ ok?: boolean; message?: string }>(ANSWER_SERVICE, { prompt_id: prompt.id, answer: option }, 15000);
        if (result && result.ok === false) throw new Error(result.message || "the robot refused the answer");
      } else {
        await missionApi.answerPrompt(prompt.id, option);
      }
      toast(`Answered "${option}"`, "info");
      this.#record({ text: prompt.text, answer: option, by: "you", at: Date.now() });
      this.#prompt = undefined;
    } catch (err) {
      toast(`Could not send the answer: ${message(err)}`);
    } finally {
      this.#answering = "";
      this.#render();
    }
  }

  // ----- rendering ---------------------------------------------------------

  #render(): void {
    this.#renderPrompt();
    this.#renderHistory();
    this.#renderPins();
  }

  #renderPrompt(): void {
    const prompt = this.#prompt;
    this.#promptEl.replaceChildren(...(prompt ? this.#promptBlock(prompt) : [h("div", { class: "empty", text: "Nothing is waiting for an answer" })]));
    this.card.replaceChildren(...(prompt ? this.#promptBlock(prompt) : []));
    this.card.hidden = !prompt;

    const reason = this.#host.conn.state !== "connected" ? "Not connected" : this.#host.missionApi.unavailableReason;
    this.#noteEl.textContent = reason ? `Questions come from mission_runner's ask_user step. ${reason}.` : "";
    this.#noteEl.hidden = this.#noteEl.textContent === "";
    this.#noteEl.classList.toggle("warn", reason !== "" && this.#host.conn.state === "connected");
  }

  #renderHistory(): void {
    this.#historyEl.replaceChildren(
      ...this.#history.map((entry) =>
        h(
          "div",
          { class: "dash-answered", title: new Date(entry.at).toLocaleTimeString() },
          h("span", { class: "answer", text: entry.answer }),
          h("span", { class: "text", text: entry.text }),
          h("span", { class: "by", text: entry.by }),
        ),
      ),
    );
  }

  #promptBlock(prompt: Prompt): HTMLElement[] {
    const parts: HTMLElement[] = [h("div", { class: "question", text: prompt.text })];
    const meta: string[] = [];
    if (prompt.mission) meta.push(prompt.mission);
    const left = secondsLeft(prompt.expires_at);
    if (left !== undefined) meta.push(left > 0 ? `${left} s left` : "expired");
    if (meta.length > 0) parts.push(h("div", { class: "detail", text: meta.join(" · ") }));
    const options = prompt.options.length > 0 ? prompt.options : ["OK"];
    const buttons = options.map((option) => {
      const button = h("button", { class: option === prompt.default ? "primary" : "" }, option);
      button.disabled = this.#answering !== "";
      if (this.#answering === option) button.textContent = `${option}…`;
      button.addEventListener("click", () => void this.#answer(option));
      return button;
    });
    parts.push(h("div", { class: "nav-buttons" }, ...buttons));
    return parts;
  }

  #renderPins(): void {
    const pins = this.#host.settings.servicePins;
    if (pins.length === 0) {
      this.#pinsEl.replaceChildren(h("div", { class: "empty", text: "Pin a call in the Services tab to get a button here" }));
      return;
    }
    const connected = this.#host.conn.state === "connected";
    this.#pinsEl.replaceChildren(
      ...pins.map((pin, index) => {
        const result = h("span", { class: "result" });
        const call = h("button", { class: "pin-call", title: `${pin.service}\n${pin.type}\n${pin.request}` }, icon("play"), pin.label);
        call.disabled = !connected;
        call.addEventListener("click", () => void this.#callPin(pin, call, result));
        const remove = h("button", { class: "icon-only", title: "Remove this button" }, icon("close"));
        remove.addEventListener("click", () => {
          this.#host.settings.servicePins.splice(index, 1);
          this.#host.persist();
          this.#render();
        });
        return h("div", { class: "dash-pin" }, call, result, remove);
      }),
    );
  }

  async #callPin(pin: ServicePin, button: HTMLButtonElement, result: HTMLElement): Promise<void> {
    let request: unknown;
    try {
      request = pin.request.trim() === "" ? {} : JSON.parse(pin.request);
    } catch {
      result.textContent = "bad request JSON";
      return;
    }
    button.disabled = true;
    result.textContent = "…";
    try {
      const response = await this.#host.conn.callService(pin.service, request, 30000);
      const text = pretty(response, 0);
      result.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      result.classList.remove("failed");
      result.title = text;
      this.#host.toast(`${pin.label}: ${text.length > 120 ? "done" : text}`, "info");
    } catch (err) {
      result.textContent = message(err);
      result.classList.add("failed");
      this.#host.toast(`${pin.label} failed: ${message(err)}`);
    } finally {
      button.disabled = this.#host.conn.state !== "connected";
    }
  }
}

function secondsLeft(expiresAt: string | null | undefined): number | undefined {
  if (!expiresAt) return undefined;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
