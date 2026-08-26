// Minimal ACP agent for runtime tests, speaking newline-delimited JSON-RPC
// on stdio. Each prompt is echoed back as agent_message_chunk updates with
// the applied model and a turn counter, so tests can assert config
// application and session reuse. `bun fake-acp-agent.ts auth` makes
// session/new fail with the ACP auth_required error instead.
const mode = process.argv[2] ?? "ok";

const config: Record<string, unknown> = {};
let turn = 0;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(line: string): void {
  const msg = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case "session/new":
      if (mode === "auth") {
        send({ id: msg.id, error: { code: -32000, message: "auth required" } });
        break;
      }
      send({
        id: msg.id,
        result: {
          sessionId: "sess_fake",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "fast",
              options: [
                { value: "fast", name: "Fast" },
                { value: "smart", name: "Smart" },
              ],
            },
          ],
        },
      });
      break;
    case "session/set_config_option": {
      const params = msg.params as { configId: string; value: unknown };
      config[params.configId] = params.value;
      send({ id: msg.id, result: {} });
      break;
    }
    case "session/prompt": {
      const params = msg.params as {
        sessionId: string;
        prompt: Array<{ text?: string }>;
      };
      turn += 1;
      const text = params.prompt.map((block) => block.text ?? "").join("");
      const model = config.model ? `[model=${config.model}] ` : "";
      for (const chunk of [`${model}echo#${turn}: `, text]) {
        send({
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          },
        });
      }
      send({ id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: "method not found" } });
      }
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length > 0) handle(line);
  }
}
