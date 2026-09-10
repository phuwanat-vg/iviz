import { parse as parseRosMsg } from "@foxglove/rosmsg";
import { parseRos2idl } from "@foxglove/ros2idl-parser";
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import { normalizeRos2MsgText } from "./schemas";

/**
 * Builds CDR readers/writers from the schema text advertised by foxglove_bridge.
 * Readers are cached per (schemaEncoding, schemaName, schema) so reconnects reuse them.
 */
export class MessageDecoder {
  #readers = new Map<string, MessageReader>();
  #writers = new Map<string, MessageWriter>();

  parseDefinitions(schema: string, schemaEncoding: string | undefined): MessageDefinition[] {
    if (schemaEncoding === "ros2idl") {
      return parseRos2idl(schema);
    }
    // foxglove_bridge for ROS 2 uses "ros2msg". Treat undefined/unknown as ros2msg too.
    return parseRosMsg(normalizeRos2MsgText(schema), { ros2: true });
  }

  getReader(schemaName: string, schema: string, schemaEncoding?: string): MessageReader {
    const key = `${schemaEncoding ?? "ros2msg"}|${schemaName}|${schema}`;
    let reader = this.#readers.get(key);
    if (!reader) {
      reader = new MessageReader(this.parseDefinitions(schema, schemaEncoding));
      this.#readers.set(key, reader);
    }
    return reader;
  }

  getWriter(schemaName: string, schema: string, schemaEncoding?: string): MessageWriter {
    const key = `${schemaEncoding ?? "ros2msg"}|${schemaName}|${schema}`;
    let writer = this.#writers.get(key);
    if (!writer) {
      writer = new MessageWriter(this.parseDefinitions(schema, schemaEncoding));
      this.#writers.set(key, writer);
    }
    return writer;
  }
}
