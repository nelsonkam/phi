// Minimal ACP agent for runtime tests, speaking newline-delimited JSON-RPC
// on stdio. Each prompt is echoed back as agent_message_chunk updates with
// the applied model and a turn counter, so tests can assert config
// application and session reuse. `bun fake-acp-agent.ts auth` makes
// session/new fail with the ACP auth_required error instead.
const mode = process.argv[2] ?? "ok";

const config: Record<string, unknown> = {};
let turn = 0;
const newSessionId = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
let phiMcp:
  { url: string; headers: Array<{ name: string; value: string }> } | undefined;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(line: string): Promise<void> {
  const msg = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities:
            mode === "no-http"
              ? {}
              : {
                  loadSession: mode === "load-only",
                  mcpCapabilities: { http: true },
                  sessionCapabilities:
                    mode === "no-resume" || mode === "load-only"
                      ? {}
                      : { resume: {}, close: {} },
                },
        },
      });
      break;
    case "session/new":
      if (mode === "auth") {
        send({ id: msg.id, error: { code: -32000, message: "auth required" } });
        break;
      }
      capturePhiMcp(msg.params);
      send({
        id: msg.id,
        result: {
          sessionId: newSessionId,
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
    case "session/resume":
      if (mode === "resume-missing") {
        send({ id: msg.id, error: { code: -32001, message: "session not found" } });
        break;
      }
      capturePhiMcp(msg.params);
      // Simulate the one prior turn and its persisted model selection. Runtime
      // tests resume after exactly one prompt.
      turn = 1;
      config.model = "smart";
      send({ id: msg.id, result: {} });
      break;
    case "session/load": {
      capturePhiMcp(msg.params);
      turn = 1;
      config.model = "smart";
      const params = msg.params as { sessionId: string };
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed historical reply" },
          },
        },
      });
      send({ id: msg.id, result: {} });
      break;
    }
    case "session/close":
      send({ id: msg.id, result: {} });
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
      const promptText = params.prompt
        .map((block) => block.text ?? "")
        .join("");
      const text = promptText.split("User request:\n").at(-1) ?? promptText;
      const model = config.model ? `[model=${config.model}] ` : "";
      // Surfaces the once-per-session messaging preamble so tests can assert
      // exactly which prompts carried it.
      const intro = promptText.includes("Use phi's send_message tool")
        ? "[intro] "
        : "";
      if (mode === "tool") {
        await callSendMessage(`tool#${turn}: ${text}`);
        send({
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "private turn text" },
            },
          },
        });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      if (mode === "silent") {
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        break;
      }
      for (const chunk of [`${model}${intro}echo#${turn}: `, text]) {
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

function capturePhiMcp(params: Record<string, unknown> | undefined): void {
  phiMcp = (
    params as {
      mcpServers?: Array<{
        name: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
      }>;
    }
  ).mcpServers?.find((server) => server.name === "phi");
}

async function callSendMessage(content: string): Promise<void> {
  if (!phiMcp) throw new Error("phi MCP server was not announced");
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-03-26",
  });
  for (const header of phiMcp.headers) headers.set(header.name, header.value);
  const response = await fetch(phiMcp.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: turn,
      method: "tools/call",
      params: { name: "send_message", arguments: { content } },
    }),
  });
  if (!response.ok) throw new Error(`phi MCP returned ${response.status}`);
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length > 0) await handle(line);
  }
}
