import type { GatewayBrowserClient } from "../gateway";
import { extractText } from "../chat/message-extract";
import { generateUUID } from "../uuid";

/** A single streaming message within a run */
export type StreamingMessage = {
  index: number;
  text: string;
  startedAt: number;
};

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatRunId: string | null;
  /** Array of streaming messages (one per assistant message in the run) */
  chatStreamMessages: StreamingMessage[];
  /** Number of currently running tools (for loading indicator) */
  chatToolsRunning: number;
  /** Name of the most recently started tool */
  chatCurrentTool: string | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error" | "tool-start" | "tool-end";
  messageIndex?: number;
  message?: unknown;
  errorMessage?: string;
  tool?: { name: string };
};

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) return;
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    })) as { messages?: unknown[]; thinkingLevel?: string | null };
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

export async function sendChatMessage(state: ChatState, message: string): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  if (!msg) return false;

  const now = Date.now();
  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: [{ type: "text", text: msg }],
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStreamMessages = [];
  state.chatToolsRunning = 0;
  state.chatCurrentTool = null;
  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
    });
    return true;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStreamMessages = [];
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId)
    return null;

  if (payload.state === "delta") {
    const text = extractText(payload.message);
    if (typeof text === "string") {
      const messageIndex = payload.messageIndex ?? 0;
      const now = Date.now();
      
      // Find or create the message at this index
      const existing = state.chatStreamMessages.find(m => m.index === messageIndex);
      if (existing) {
        existing.text = text;
      } else {
        // Insert in order
        const newMsg: StreamingMessage = { index: messageIndex, text, startedAt: now };
        state.chatStreamMessages = [...state.chatStreamMessages, newMsg].sort(
          (a, b) => a.index - b.index
        );
      }
    }
  } else if (payload.state === "tool-start") {
    state.chatToolsRunning = (state.chatToolsRunning || 0) + 1;
    state.chatCurrentTool = payload.tool?.name ?? null;
  } else if (payload.state === "tool-end") {
    state.chatToolsRunning = Math.max(0, (state.chatToolsRunning || 0) - 1);
    if (state.chatToolsRunning === 0) {
      state.chatCurrentTool = null;
    }
  } else if (payload.state === "final") {
    state.chatStreamMessages = [];
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
  } else if (payload.state === "aborted") {
    state.chatStreamMessages = [];
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
  } else if (payload.state === "error") {
    state.chatStreamMessages = [];
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
