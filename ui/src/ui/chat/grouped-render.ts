import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { AssistantIdentity } from "../assistant-identity";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { MessageGroup, ToolCard } from "../types/chat-types";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards";

/**
 * Collect and pair tool cards from all messages in a group.
 * This ensures toolCall cards are merged with their corresponding toolResult.
 */
function collectAndPairToolCards(messages: Array<{ message: unknown }>): ToolCard[] {
  const callCards: ToolCard[] = [];
  const resultCards: ToolCard[] = [];

  for (const { message } of messages) {
    const cards = extractToolCards(message);
    for (const card of cards) {
      if (card.kind === "call") {
        callCards.push(card);
      } else {
        resultCards.push(card);
      }
    }
  }

  // Merge result text into call cards by matching id/name
  const paired: ToolCard[] = [];
  const usedResults = new Set<number>();

  for (const call of callCards) {
    // Find matching result by id first, then by name
    let resultIndex = -1;
    if (call.id) {
      resultIndex = resultCards.findIndex((r, i) => !usedResults.has(i) && r.id === call.id);
    }
    if (resultIndex === -1) {
      resultIndex = resultCards.findIndex((r, i) => !usedResults.has(i) && r.name === call.name);
    }

    if (resultIndex !== -1) {
      usedResults.add(resultIndex);
      // Merge: call card gets the result text
      paired.push({
        ...call,
        text: resultCards[resultIndex].text,
      });
    } else {
      // No result yet (still running or no output)
      paired.push(call);
    }
  }

  // Add any orphan results (shouldn't happen normally)
  for (let i = 0; i < resultCards.length; i++) {
    if (!usedResults.has(i)) {
      paired.push(resultCards[i]);
    }
  }

  return paired;
}

export type ReadingIndicatorOptions = {
  toolsRunning?: number;
  currentTool?: string | null;
};

export function renderReadingIndicatorGroup(
  assistant?: AssistantIdentity,
  options?: ReadingIndicatorOptions,
) {
  const { toolsRunning = 0, currentTool = null } = options ?? {};
  const showToolIndicator = toolsRunning > 0 && currentTool;

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          ${showToolIndicator
            ? html`
                <span class="chat-reading-indicator__tool">
                  <span class="chat-reading-indicator__spinner"></span>
                  <span class="chat-reading-indicator__tool-name">${currentTool}</span>
                </span>
              `
            : html`
                <span class="chat-reading-indicator__dots">
                  <span></span><span></span><span></span>
                </span>
              `}
        </div>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  // Collect and pair tool cards across all messages in the group
  // This ensures toolCall and toolResult are merged into single cards
  const pairedToolCards = collectAndPairToolCards(group.messages);

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming:
                group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
              // Pass paired cards only for first non-toolResult message
              pairedToolCards: index === 0 ? pairedToolCards : undefined,
              skipToolCards: index > 0, // Skip tool cards for subsequent messages
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "assistant"
        ? assistantName.charAt(0).toUpperCase() || "A"
        : normalized === "tool"
          ? "⚙"
          : "?";
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
      : normalized === "tool"
          ? "tool"
          : "other";

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    return html`<div class="chat-avatar ${className}">${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /^\//.test(value) // Relative paths from avatar endpoint
  );
}

function renderGroupedMessage(
  message: unknown,
  opts: {
    isStreaming: boolean;
    showReasoning: boolean;
    pairedToolCards?: ToolCard[];
    skipToolCards?: boolean;
  },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  // Use paired tool cards if provided, otherwise extract from this message
  // skipToolCards: don't render any tool cards (they were rendered by first message in group)
  const toolCards = opts.skipToolCards ? [] : (opts.pairedToolCards ?? extractToolCards(message));
  const hasToolCards = toolCards.length > 0;

  // For toolResult messages, only render tool cards (which we got from pairing)
  // If skipToolCards is true, render nothing for toolResult messages
  if (isToolResult) {
    if (opts.skipToolCards || !hasToolCards) {
      return nothing;
    }
    return html`${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}`;
  }

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant"
      ? extractThinkingCached(message)
      : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking
    ? formatReasoningMarkdown(extractedThinking)
    : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  // Note: Tool result messages are handled above (early return)
  if (!markdown && !hasToolCards) return nothing;

  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
      ${reasoningMarkdown
        ? html`<div class="chat-thinking">${unsafeHTML(
            toSanitizedMarkdownHtml(reasoningMarkdown),
          )}</div>`
        : nothing}
      ${markdown
        ? html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
        : nothing}
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}
