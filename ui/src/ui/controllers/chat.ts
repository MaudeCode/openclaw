import type { GatewayBrowserClient } from "../gateway";
import { extractText } from "../chat/message-extract";
import { generateUUID } from "../uuid";

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
  tool?: { name: string; args?: unknown; result?: string };
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
  // Add user message to chatMessages
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
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
    state.lastError = error;
    // Add error message
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
      
      // Find or create assistant message at this index
      // Messages are indexed from the start of this run
      const runStartIndex = findRunStartIndex(state.chatMessages);
      const targetIndex = runStartIndex + messageIndex;
      
      if (targetIndex < state.chatMessages.length) {
        // Update existing message
        const existing = state.chatMessages[targetIndex] as Record<string, unknown>;
        if (existing.role === "assistant") {
          const content = Array.isArray(existing.content) ? [...existing.content] : [];
          const textItem = content.find((c: any) => c.type === "text");
          if (textItem) {
            (textItem as any).text = text;
          } else {
            content.unshift({ type: "text", text });
          }
          state.chatMessages = [
            ...state.chatMessages.slice(0, targetIndex),
            { ...existing, content },
            ...state.chatMessages.slice(targetIndex + 1),
          ];
        }
      } else {
        // Add new assistant message
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
            _streaming: true,
          },
        ];
      }
    }
  } else if (payload.state === "tool-start") {
    state.chatToolsRunning = (state.chatToolsRunning || 0) + 1;
    state.chatCurrentTool = payload.tool?.name ?? null;
    // Don't add tool_use to messages - history will provide tool cards
  } else if (payload.state === "tool-end") {
    state.chatToolsRunning = Math.max(0, (state.chatToolsRunning || 0) - 1);
    if (state.chatToolsRunning === 0) {
      state.chatCurrentTool = null;
    }
    // Don't add tool results - history will provide them
  } else if (payload.state === "final") {
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
    // Mark streaming messages as complete
    state.chatMessages = state.chatMessages.map(m => {
      const msg = m as Record<string, unknown>;
      if (msg._streaming) {
        const { _streaming, ...rest } = msg;
        return rest;
      }
      return m;
    });
  } else if (payload.state === "aborted") {
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
  } else if (payload.state === "error") {
    state.chatRunId = null;
    state.chatToolsRunning = 0;
    state.chatCurrentTool = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}

function findRunStartIndex(messages: unknown[]): number {
  // Find the index after the last user message (start of current run)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === "user") {
      return i + 1;
    }
  }
  return 0;
}
