import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";
import type { ToolResult } from "@/lib/graph/tools/types";
import { signSession } from "@/lib/server/mcp-session";
import type { Emit } from "./catalog";
import { toolsFor, type AgentRole } from "./toolbox";

export interface McpToolset {
  tools: ToolSet;
  /** The tool names tools/list returned for this agent's role. */
  names: string[];
  server: string;
  close: () => Promise<void>;
}

interface Options {
  /** The deployment's own origin: the agents use the same MCP server an outside agent does. */
  origin: string;
  visitorId: string;
  role: AgentRole;
  emit: Emit;
  /** The model's last sentence before this call: why it chose the tool. */
  why: () => string;
  /** Called with each result, e.g. to record it as an episode with the model's reason. */
  onResult?: (result: ToolResult, input: unknown, why: string) => void;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** The session travels in a header, so the model never sees (or invents) a session argument. */
function withoutSession(schema: unknown): JSONSchema7 {
  const s = { ...(schema as JSONSchema7) };
  if (s.properties) {
    const { session: _drop, ...rest } = s.properties as Record<string, JSONSchema7>;
    void _drop;
    s.properties = rest;
  }
  if (Array.isArray(s.required)) s.required = s.required.filter((k) => k !== "session");
  return s;
}

const textOf = (r: unknown) => {
  const content = (r as { content?: unknown }).content;
  return Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") : "";
};

/**
 * Connects an agent to Detour's MCP server, discovers its tools there (tools/list), keeps the ones its role uses, and
 * wraps each so a call goes over MCP (tools/call). The control room still sees every step with its Cypher (the
 * server's structured result) while the model reads only the compact view the server wrote for it.
 */
export async function mcpToolset(o: Options): Promise<McpToolset> {
  const timeout = o.timeoutMs ?? 8_000;
  const server = `${o.origin}/api/mcp`;
  const client: MCPClient = await withTimeout(
    createMCPClient({ transport: { type: "http", url: server, headers: { "x-detour-session": signSession(o.visitorId, o.role) } } }),
    timeout,
    "Connecting to the MCP server",
  );
  try {
    const listed = await withTimeout(client.listTools(), timeout, "Listing the MCP tools");
    const allowed = new Set(toolsFor(o.role).map((t) => t.name));
    const tools: ToolSet = {};
    let seq = 0;
    for (const t of listed.tools) {
      if (!allowed.has(t.name)) continue;
      tools[t.name] = dynamicTool({
        description: t.description ?? t.title ?? t.name,
        inputSchema: jsonSchema(withoutSession(t.inputSchema)),
        execute: async (input) => {
          const id = `${t.name}-${++seq}`;
          const why = o.why();
          o.emit({ type: "tool-call", agent: o.role, id, tool: t.name, input, via: "mcp" });
          try {
            const res = await client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> });
            const result = (res.structuredContent as { result?: ToolResult } | undefined)?.result;
            const message = textOf(res);
            if (res.isError || !result) {
              o.emit({ type: "tool-error", agent: o.role, id, tool: t.name, message: message || "The tool returned no result." });
              return { outcome: "error", summary: message || "The tool returned no result. Try a different step or report the gap." };
            }
            o.emit({ type: "tool-result", agent: o.role, id, result });
            o.onResult?.(result, input, why);
            try {
              return JSON.parse(message);
            } catch {
              return { outcome: result.outcome, summary: result.summary };
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            o.emit({ type: "tool-error", agent: o.role, id, tool: t.name, message: msg });
            return { outcome: "error", summary: `The tool failed: ${msg}. Try a different step or report the gap.` };
          }
        },
      });
    }
    if (!Object.keys(tools).length) throw new Error("The MCP server listed none of this agent's tools.");
    return { tools, names: Object.keys(tools), server: "/api/mcp", close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
