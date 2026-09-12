/**
 * mission_runner's `ask_user` step, simulated.
 *
 * With `--prompt` the mock asks a question every 20 seconds on
 * `/mission/event` and serves `/mission/answer`
 * (`mission_msgs/srv/Answer`), exactly as the runner does on a robot, so the
 * Dashboard can be exercised without mission_runner.
 */
import { createRequire } from "node:module";
import type { FoxgloveServer, IWebSocket, ServiceCallRequest } from "@foxglove/ws-protocol";
import type { MessageReader as MessageReaderT, MessageWriter as MessageWriterT } from "@foxglove/rosmsg2-serialization";

const require = createRequire(import.meta.url);
const { parse } = require("@foxglove/rosmsg") as typeof import("@foxglove/rosmsg");
const { MessageReader, MessageWriter } = require("@foxglove/rosmsg2-serialization") as typeof import("@foxglove/rosmsg2-serialization");

const ANSWER_REQUEST = "string prompt_id\nstring answer";
const ANSWER_RESPONSE = "bool ok\nstring message";

const QUESTIONS = [
  { text: "The pallet is in place. Continue?", options: ["Yes", "No"], default: "Yes" },
  { text: "The door did not open. What now?", options: ["Retry", "Skip", "Stop"], default: "Retry" },
  { text: "Which conveyor should I unload to?", options: ["Left", "Right"], default: "Left" },
];

interface Prompt {
  id: string;
  run_id: string;
  mission: string;
  step_id: string;
  text: string;
  options: string[];
  default: string;
  expires_at: string;
}

export interface PromptSim {
  handleServiceCall(req: ServiceCallRequest, conn: IWebSocket): boolean;
}

export function createPromptSim(server: FoxgloveServer, publishEvent: (event: Record<string, unknown>) => void, enabled: boolean): PromptSim {
  const definitionsIn = parse(ANSWER_REQUEST, { ros2: true });
  const definitionsOut = parse(ANSWER_RESPONSE, { ros2: true });
  const reader: MessageReaderT = new MessageReader(definitionsIn);
  const writer: MessageWriterT = new MessageWriter(definitionsOut);

  const serviceId = server.addService({
    name: "/mission/answer",
    type: "mission_msgs/srv/Answer",
    request: { encoding: "cdr", schemaName: "mission_msgs/srv/Answer_Request", schemaEncoding: "ros2msg", schema: ANSWER_REQUEST },
    response: { encoding: "cdr", schemaName: "mission_msgs/srv/Answer_Response", schemaEncoding: "ros2msg", schema: ANSWER_RESPONSE },
  });

  let pending: Prompt | undefined;
  let next = 0;

  const reply = (req: ServiceCallRequest, conn: IWebSocket, ok: boolean, message: string): void => {
    const data = writer.writeMessage({ ok, message });
    server.sendServiceCallResponse({ serviceId: req.serviceId, callId: req.callId, encoding: "cdr", data: data as unknown as DataView }, conn);
  };

  let lastAsk = 0;
  if (enabled) {
    setInterval(() => {
      // A client that connects late asks the runner for the pending question
      // over its HTTP API; the mock has none, so it repeats the event instead.
      if (pending) {
        publishEvent({ type: "prompt", prompt: pending });
        return;
      }
      if (Date.now() - lastAsk < 20_000) return;
      lastAsk = Date.now();
      const question = QUESTIONS[next % QUESTIONS.length]!;
      next++;
      pending = {
        id: Math.random().toString(16).slice(2, 10),
        run_id: "sim-run",
        mission: "demo",
        step_id: "ask_user",
        text: question.text,
        options: question.options,
        default: question.default,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      };
      console.log(`[mock] asking: ${pending.text} (${pending.options.join(" / ")})`);
      publishEvent({ type: "prompt", prompt: pending });
    }, 5_000);
  }

  return {
    handleServiceCall(req, conn) {
      if (req.serviceId !== serviceId) return false;
      let request: { prompt_id?: string; answer?: string };
      try {
        request = reader.readMessage(req.data) as { prompt_id?: string; answer?: string };
      } catch (err) {
        reply(req, conn, false, `request did not decode: ${String(err)}`);
        return true;
      }
      const answer = request.answer ?? "";
      if (!pending || pending.id !== request.prompt_id) {
        reply(req, conn, false, "no such prompt");
        return true;
      }
      if (!pending.options.includes(answer)) {
        reply(req, conn, false, `answer must be one of ${pending.options.join(", ")}`);
        return true;
      }
      console.log(`[mock] answered "${answer}" for prompt ${pending.id}`);
      publishEvent({ type: "prompt.answered", prompt_id: pending.id, answer, by: "user" });
      pending = undefined;
      reply(req, conn, true, "ok");
      return true;
    },
  };
}
