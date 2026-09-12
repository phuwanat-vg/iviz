/**
 * The Services tab: call any service the bridge advertises.
 *
 * The request form is generated from the schema the bridge sends, so it fits
 * whatever the robot offers, from `std_srvs/Trigger` to Nav2's costmap
 * services. A filled-in call can be pinned as a button on the Dashboard.
 */

import type { Service } from "@foxglove/ws-protocol";
import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { AppSettings } from "../state/settings";
import { MessageForm } from "./MessageForm";
import { h, row } from "./dom";
import { icon } from "./icons";

export interface ServicePanelHost {
  conn: FoxgloveConnection;
  settings: AppSettings;
  persist(): void;
  toast(message: string, kind?: "error" | "info"): void;
  /** The dashboard redraws its buttons after a pin is added. */
  onPinsChanged(): void;
}

export class ServicePanel {
  readonly element: HTMLElement;

  #host: ServicePanelHost;
  #search: HTMLInputElement;
  #hiddenChk: HTMLInputElement;
  #note: HTMLElement;
  #list: HTMLElement;
  #detail: HTMLElement;
  #selected = "";
  #listKey = "";
  #detailKey = "";
  #disposers: (() => void)[] = [];

  constructor(host: ServicePanelHost) {
    this.#host = host;
    this.#search = h("input", { type: "text", placeholder: "Search by name or type" });
    this.#search.addEventListener("input", () => this.#renderList(true));
    this.#hiddenChk = h("input", { type: "checkbox", title: "Include the hidden services behind ROS 2 actions" });
    this.#hiddenChk.addEventListener("change", () => this.#renderList(true));
    this.#note = h("div", { class: "nav-note" });
    this.#list = h("div", { class: "svc-list" });
    this.#detail = h("div", { class: "svc-detail" });
    this.element = h(
      "div",
      { class: "svc-panel" },
      h("div", { class: "row" }, this.#search),
      row("Action internals", this.#hiddenChk),
      this.#note,
      this.#list,
      this.#detail,
    );
    this.#disposers.push(host.conn.onServicesChange(() => this.refresh()));
    this.#disposers.push(host.conn.onStateChange(() => this.refresh()));
    this.refresh();
  }

  refresh(): void {
    this.#renderList(false);
    this.#renderDetail(false);
  }

  dispose(): void {
    for (const d of this.#disposers) d();
    this.#disposers = [];
  }

  #matching(): Service[] {
    const query = this.#search.value.trim().toLowerCase();
    return this.#host.conn.services.filter((s) => {
      if (!this.#hiddenChk.checked && s.name.includes("/_action/")) return false;
      if (query === "") return true;
      return s.name.toLowerCase().includes(query) || s.type.toLowerCase().includes(query);
    });
  }

  #renderList(force: boolean): void {
    const conn = this.#host.conn;
    const matching = this.#matching();
    const key = `${conn.state}|${this.#search.value}|${this.#hiddenChk.checked}|${this.#selected}|${matching.map((s) => s.name).join(",")}`;
    if (!force && key === this.#listKey) return;
    this.#listKey = key;

    if (conn.state !== "connected") {
      this.#note.textContent = "Connect to a robot to call its services.";
      this.#list.replaceChildren();
      return;
    }
    if (!conn.supportsServices) {
      this.#note.textContent = "This bridge cannot call services.";
      this.#list.replaceChildren();
      return;
    }
    const total = conn.services.length;
    this.#note.textContent = matching.length === total ? `${total} services` : `${matching.length} of ${total} services`;
    const rows: HTMLElement[] = matching.map((service) => {
      const button = h(
        "button",
        { class: `svc-item${service.name === this.#selected ? " active" : ""}`, title: `${service.name}\n${service.type}` },
        h("span", { class: "name", text: service.name }),
        h("span", { class: "type", text: shortType(service.type) }),
      );
      button.addEventListener("click", () => {
        this.#selected = service.name === this.#selected ? "" : service.name;
        this.#renderList(true);
        this.#renderDetail(true);
      });
      return button;
    });
    if (rows.length === 0) rows.push(h("div", { class: "empty", text: "Nothing matches" }));
    this.#list.replaceChildren(...rows);
  }

  /** Rebuilt only when the selection or its schema changes, so typing survives. */
  #renderDetail(force: boolean): void {
    const conn = this.#host.conn;
    const service = this.#selected ? conn.services.find((s) => s.name === this.#selected) : undefined;
    const key = service ? `${service.name}|${service.type}|${conn.state}` : `none|${conn.state}`;
    if (!force && key === this.#detailKey) return;
    this.#detailKey = key;

    if (!service) {
      this.#detail.replaceChildren();
      return;
    }

    const definitions = conn.serviceDefinitions(service.name);
    const form = definitions ? new MessageForm(definitions.request) : undefined;
    const response = h("pre", { class: "svc-response" });
    response.hidden = true;

    const callButton = h("button", { class: "primary" }, icon("play"), "Call");
    const pinButton = h("button", { title: "Put this call on the Dashboard as a button" }, icon("plus"), "Pin");

    const show = (text: string, failed: boolean): void => {
      response.textContent = text;
      response.hidden = false;
      response.classList.toggle("failed", failed);
    };

    callButton.addEventListener("click", async () => {
      if (!form) {
        show("The bridge did not send a schema for this service, so iViz cannot build the request.", true);
        return;
      }
      let request: Record<string, unknown>;
      try {
        request = form.value();
      } catch (err) {
        show(message(err), true);
        return;
      }
      callButton.disabled = true;
      const started = performance.now();
      try {
        const result = await conn.callService(service.name, request, 30000);
        show(`${Math.round(performance.now() - started)} ms\n${pretty(result)}`, false);
      } catch (err) {
        show(message(err), true);
      } finally {
        callButton.disabled = false;
      }
    });

    pinButton.addEventListener("click", () => {
      if (!form) return;
      let request: Record<string, unknown>;
      try {
        request = form.value();
      } catch (err) {
        this.#host.toast(message(err));
        return;
      }
      const label = service.name.split("/").filter(Boolean).pop() ?? service.name;
      this.#host.settings.servicePins.push({ label, service: service.name, type: service.type, request: pretty(request, 0) });
      this.#host.persist();
      this.#host.onPinsChanged();
      this.#host.toast(`${label} pinned to the Dashboard`, "info");
    });

    this.#detail.replaceChildren(
      h("div", { class: "svc-head" }, h("div", { class: "name", text: service.name }), h("div", { class: "type", text: service.type })),
      form ? form.element : h("div", { class: "nav-note warn", text: "This bridge advertised no request schema for this service." }),
      h("div", { class: "nav-buttons" }, callButton, pinButton),
      response,
    );
  }
}

function shortType(type: string): string {
  return type.slice(type.lastIndexOf("/") + 1);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** JSON with the types CDR decoding produces, trimmed to something readable. */
export function pretty(value: unknown, indent = 2): string {
  const text = JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "bigint") return v.toString();
      if (ArrayBuffer.isView(v)) {
        const list = Array.from(v as unknown as ArrayLike<number>);
        return list.length > 64 ? [...list.slice(0, 64), `… ${list.length} values`] : list;
      }
      return v;
    },
    indent,
  );
  if (text === undefined) return String(value);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… truncated` : text;
}
