// Shared Claude call helper -- same shape proven in AIFF's
// electron/specExtraction.js: forced tool-use, adaptive thinking, streaming
// (avoids request timeouts on long documents), extract the tool_use block.
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeTool } from "@easy/extraction-schemas";

export async function callTool<T = unknown>(
  client: Anthropic,
  opts: {
    tool: ClaudeTool;
    systemPrompt: string;
    userText: string;
    maxTokens: number;
    useThinking: boolean;
    // Base64-encoded PNG page images -- for schematic/CAD-exported drawings
    // (ISOs, P&IDs, PFDs) where the title block/tables are vector graphics
    // with little or no real text layer, and plain text extraction (see
    // pdfText.ts) isn't enough (confirmed on a real ISO upload).
    images?: string[];
  }
): Promise<T> {
  const content: Anthropic.MessageParam["content"] = [
    ...(opts.images ?? []).map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
    { type: "text" as const, text: opts.userText },
  ];

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: opts.maxTokens,
    output_config: { effort: "high" },
    ...(opts.useThinking ? { thinking: { type: "adaptive" as const } } : {}),
    system: opts.systemPrompt,
    tools: [opts.tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content }],
  });

  const finalMessage = await stream.finalMessage();
  const u = finalMessage.usage;
  console.log(
    `[claude] ${opts.tool.name}: input=${u.input_tokens} output=${u.output_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`
  );
  const toolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Claude did not return a ${opts.tool.name} tool call.`);
  }
  return toolUse.input as T;
}

export async function callWithRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
