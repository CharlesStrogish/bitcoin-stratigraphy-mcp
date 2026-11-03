/** JSON and finite SSE responses are both valid MCP Streamable HTTP results. */
export async function readRpc(response: Response, id: number): Promise<unknown> {
  if (!response.ok) throw new Error(`MCP_HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MCP_EMPTY_RESPONSE");
  const decoder = new TextDecoder();
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  let buffer = "", size = 0;
  const parse = (text: string): { matched: boolean; result?: unknown } => {
    const message = JSON.parse(text);
    if (message.id !== id) return { matched: false };
    if (message.jsonrpc !== "2.0") throw new Error("MCP_INVALID_RESPONSE");
    // Do not reflect server text that could contain bearer credentials.
    if (message.error) throw new Error(`MCP_RPC_${message.error.code}`);
    if (!Object.hasOwn(message, "result")) throw new Error("MCP_MISSING_RESULT");
    return { matched: true, result: message.result };
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error("MCP_RESPONSE_TOO_LARGE");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (sse) {
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const text = event.split("\n").filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!text) continue;
          const parsed = parse(text);
          if (parsed.matched) return parsed.result;
        }
      } else if (done) {
        const parsed = parse(buffer);
        if (parsed.matched) return parsed.result;
      }
      if (done) throw new Error("MCP_RESPONSE_ID_MISMATCH");
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
