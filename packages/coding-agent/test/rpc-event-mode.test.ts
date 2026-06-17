import { describe, expect, test } from "vitest";
import { createRpcEventTransformer } from "../src/modes/rpc/rpc-event-mode.js";
import type { RpcEventMode } from "../src/modes/rpc/rpc-types.js";

describe("RPC compact event mode", () => {
	test("full mode leaves events unchanged", () => {
		let mode: RpcEventMode = "full";
		const transform = createRpcEventTransformer(() => mode);
		const event = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				partial: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			},
		};

		expect(transform(event)).toBe(event);
		mode = "compact";
		expect(transform({ type: "agent_start" })).toEqual({ type: "agent_start" });
	});

	test("compact mode removes repeated assistant partials from message updates", () => {
		const transform = createRpcEventTransformer(() => "compact");
		const event = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "lo",
				partial: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			},
		};

		expect(transform(event)).toEqual({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "lo",
			},
		});
	});

	test("compact mode emits tool update deltas instead of accumulated text", () => {
		const transform = createRpcEventTransformer(() => "compact");

		expect(
			transform({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "printf" },
				partialResult: { content: [{ type: "text", text: "hello" }], details: { fullOutputPath: undefined } },
			}),
		).toEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "printf" },
			partialResultDelta: {
				content: [{ type: "text", text: "hello" }],
				details: { fullOutputPath: undefined },
			},
		});

		expect(
			transform({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "printf" },
				partialResult: { content: [{ type: "text", text: "hello world" }], details: { fullOutputPath: undefined } },
			}),
		).toEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "printf" },
			partialResultDelta: {
				content: [{ type: "text", text: " world" }],
				details: { fullOutputPath: undefined },
			},
		});
	});

	test("compact mode summarizes final duplicate events", () => {
		const transform = createRpcEventTransformer(() => "compact");

		expect(
			transform({
				type: "turn_end",
				message: { role: "assistant", stopReason: "toolUse" },
				toolResults: [{ role: "toolResult" }, { role: "toolResult" }],
			}),
		).toEqual({
			type: "turn_end",
			toolResultCount: 2,
			messageRole: "assistant",
			stopReason: "toolUse",
		});

		expect(transform({ type: "agent_end", messages: [{}, {}, {}] })).toEqual({
			type: "agent_end",
			messageCount: 3,
		});
	});
});
