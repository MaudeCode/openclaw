# Webchat Streaming Improvement Plan

## Problem

When the agent makes tool calls during a response, the webchat streaming experience is poor:
1. Text gets truncated/replaced when tools start
2. During tool execution, users see incomplete text or frozen UI
3. All messages are concatenated into one blob, then split on completion

## Goal

Stream each assistant message as a **separate bubble**, exactly like the final view shows them. Natural breaks at tool calls.

## Current Architecture (to be replaced)

```
Server (server-chat.ts):
- Accumulates all text into one string via buffers Map
- Broadcasts single "delta" with concatenated text
- Throttles at 150ms intervals (causes text loss before tool calls)

UI (controllers/chat.ts):
- chatStream: string | null (single stream)
- Displays one streaming bubble, replaces with history on completion
```

## New Architecture

### Server Changes

```typescript
// server-chat.ts

// Track messages array per run instead of single buffer
messagesByRun: Map<string, Array<{ text: string; seq: number }>>

// New payload structure
type ChatDeltaPayload = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta";
  messageIndex: number;      // NEW: which message in the run (0, 1, 2...)
  message: {
    role: "assistant";
    content: [{ type: "text"; text: string }];
    timestamp: number;
  };
};
```

**Logic:**
1. On first assistant text → messageIndex = 0
2. On tool-start → increment messageIndex counter (next text will be new message)
3. On assistant text after tool → use new messageIndex
4. Each delta only contains text for its own message (no accumulation)

### UI Changes

```typescript
// controllers/chat.ts

// Replace single stream with array
chatStreamMessages: Array<{
  index: number;
  text: string;
  startedAt: number;
}>;

// Track which message is currently streaming
chatStreamCurrentIndex: number;
```

**Logic:**
1. On delta with messageIndex → update that specific message in array
2. On tool-start → show tool indicator after current message
3. On tool-end → ready for next message
4. Render each streaming message as separate bubble

### View Changes

```typescript
// views/chat.ts buildChatItems()

// Instead of single "stream" item, render array of streaming messages
if (props.chatStreamMessages.length > 0) {
  for (const msg of props.chatStreamMessages) {
    items.push({
      kind: "stream",
      key: `stream:${msg.index}`,
      text: msg.text,
      startedAt: msg.startedAt,
    });
  }
  // Add tool indicator after last message if tools running
  if (props.toolsRunning > 0) {
    items.push({ 
      kind: "tool-indicator", 
      key: "tool-running",
      toolName: props.currentTool 
    });
  }
}
```

## Migration Steps

### Phase 1: Server - Message Indexing
- [ ] Add `messageIndexByRun: Map<string, number>` to track current message index
- [ ] Add `messageIndex` field to delta payloads
- [ ] On tool-start event, increment the message index
- [ ] Remove buffer accumulation logic (buffers, lastMessageText)
- [ ] Remove throttling (each message streams independently)

### Phase 2: UI - Multiple Streaming Messages  
- [ ] Replace `chatStream: string` with `chatStreamMessages: Array<...>`
- [ ] Update `handleChatEvent` to handle messageIndex
- [ ] Update delta handler to update correct message in array
- [ ] Reset array on final/error/aborted

### Phase 3: View - Render Message Array
- [ ] Update `buildChatItems()` to render streaming message array
- [ ] Each streaming message gets its own bubble
- [ ] Tool indicator appears after current message during tool calls
- [ ] Style consistency between streaming and final messages

### Phase 4: Cleanup
- [ ] Remove old accumulation code
- [ ] Remove debug logging
- [ ] Update tests
- [ ] Test with various tool call patterns

## Benefits

1. **Simpler code** - No complex boundary detection or accumulation
2. **Better UX** - Messages appear naturally, one at a time
3. **No text loss** - Each message streams independently
4. **Consistent view** - Streaming looks like final result

## Backwards Compatibility

- New `messageIndex` field is additive
- Old clients without messageIndex support will see only the last message (graceful degradation)
- Can be feature-flagged if needed

## Files to Modify

Server:
- `src/gateway/server-chat.ts` - Main streaming logic

UI:
- `ui/src/ui/controllers/chat.ts` - State and event handling
- `ui/src/ui/views/chat.ts` - Render logic
- `ui/src/ui/types/chat-types.ts` - Type definitions
- `ui/src/ui/app.ts` - State properties
- `ui/src/ui/app-render.ts` - Props passing
