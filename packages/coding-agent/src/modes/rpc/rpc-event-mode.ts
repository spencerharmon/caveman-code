import type {
	RpcCompactAgentEvent,
	RpcCompactAssistantMessageEvent,
	RpcCompactToolResultDelta,
	RpcEventMode,
} from "./rpc-types.js";

interface RpcEventTransformerState {
	toolUpdateTextById: Map<string, string>;
}

export function createRpcEventTransformer(getMode: () => RpcEventMode): (event: object) => object {
	const state: RpcEventTransformerState = {
		toolUpdateTextById: new Map(),
	};

	return (event) => transformRpcEvent(event, getMode(), state);
}

function transformRpcEvent(event: object, mode: RpcEventMode, state: RpcEventTransformerState): object {
	if (mode === "full") return event;

	const record = event as Record<string, unknown>;
	const type = record.type;
	if (typeof type !== "string") return event;

	switch (type) {
		case "message_update":
			return compactMessageUpdate(record);
		case "tool_execution_start":
			forgetToolUpdateText(record, state);
			return event;
		case "tool_execution_update":
			return compactToolExecutionUpdate(record, state);
		case "tool_execution_end":
			forgetToolUpdateText(record, state);
			return event;
		case "turn_end":
			return compactTurnEnd(record);
		case "agent_end":
			return compactAgentEnd(record);
		default:
			return event;
	}
}

function compactMessageUpdate(event: Record<string, unknown>): RpcCompactAgentEvent | Record<string, unknown> {
	const assistantMessageEvent = compactAssistantMessageEvent(event.assistantMessageEvent);
	if (!assistantMessageEvent) return event;
	return {
		type: "message_update",
		assistantMessageEvent,
	};
}

function compactAssistantMessageEvent(value: unknown): RpcCompactAssistantMessageEvent | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;

	if (value.type === "text_delta" || value.type === "thinking_delta" || value.type === "toolcall_delta") {
		if (typeof value.contentIndex !== "number" || typeof value.delta !== "string") return undefined;
		return { type: value.type, contentIndex: value.contentIndex, delta: value.delta };
	}

	if (
		value.type === "text_start" ||
		value.type === "text_end" ||
		value.type === "thinking_start" ||
		value.type === "thinking_end" ||
		value.type === "toolcall_start"
	) {
		if (typeof value.contentIndex !== "number") return undefined;
		return { type: value.type, contentIndex: value.contentIndex };
	}

	if (value.type === "toolcall_end") {
		if (typeof value.contentIndex !== "number") return undefined;
		return { type: value.type, contentIndex: value.contentIndex, toolCall: value.toolCall };
	}

	return undefined;
}

function compactToolExecutionUpdate(
	event: Record<string, unknown>,
	state: RpcEventTransformerState,
): RpcCompactAgentEvent {
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
	const toolName = typeof event.toolName === "string" ? event.toolName : "";
	const args = event.args;
	const partialResult = event.partialResult;
	const currentText = extractSingleTextResult(partialResult);
	const details = extractDetails(partialResult);

	if (!toolCallId || currentText === undefined) {
		return {
			type: "tool_execution_update",
			toolCallId,
			toolName,
			args,
			partialResult,
		};
	}

	const previousText = state.toolUpdateTextById.get(toolCallId) ?? "";
	const overlap = findSuffixPrefixOverlap(previousText, currentText);
	const text = currentText.slice(overlap);
	state.toolUpdateTextById.set(toolCallId, currentText);

	const partialResultDelta: RpcCompactToolResultDelta = {
		content: [{ type: "text", text }],
	};
	if (details !== undefined) {
		partialResultDelta.details = details;
	}
	if (overlap === 0 && previousText.length > 0) {
		partialResultDelta.resync = true;
		partialResultDelta.content = [{ type: "text", text: currentText }];
	}

	return {
		type: "tool_execution_update",
		toolCallId,
		toolName,
		args,
		partialResultDelta,
	};
}

function compactTurnEnd(event: Record<string, unknown>): RpcCompactAgentEvent {
	const message = isRecord(event.message) ? event.message : undefined;
	const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
	const compact: RpcCompactAgentEvent = {
		type: "turn_end",
		toolResultCount: toolResults.length,
	};

	if (message && typeof message.role === "string") {
		compact.messageRole = message.role;
	}
	if (message && typeof message.stopReason === "string") {
		compact.stopReason = message.stopReason;
	}
	return compact;
}

function compactAgentEnd(event: Record<string, unknown>): RpcCompactAgentEvent {
	return {
		type: "agent_end",
		messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
	};
}

function forgetToolUpdateText(event: Record<string, unknown>, state: RpcEventTransformerState): void {
	if (typeof event.toolCallId === "string") {
		state.toolUpdateTextById.delete(event.toolCallId);
	}
}

function extractSingleTextResult(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const content = value.content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const first = content[0];
	if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") return undefined;
	return first.text;
}

function extractDetails(value: unknown): unknown {
	if (!isRecord(value)) return undefined;
	return value.details;
}

function findSuffixPrefixOverlap(previous: string, current: string): number {
	const maxLength = Math.min(previous.length, current.length);
	if (maxLength === 0) return 0;
	if (current.startsWith(previous)) return previous.length;

	for (let length = maxLength; length > 0; length--) {
		if (previous.endsWith(current.slice(0, length))) {
			return length;
		}
	}
	return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
