import { DEFAULT_AGENT_NAME, loadAgents } from "./registry";

export interface MessageRouting {
  mentions: string[];
  routedTo: string[];
}

const LEADING_MENTION = /^\s*@([a-z0-9][a-z0-9-]*)\b/;

export function leadingMention(content: string): string | null {
  return content.match(LEADING_MENTION)?.[1] ?? null;
}

// `fallbackAgent` is the thread's own default — the agent its root message
// routed to — so a thread opened with "@researcher ..." keeps researcher for
// unmentioned replies. A stale fallback (agent since deleted) degrades to the
// workspace default rather than failing the message.
export async function routeUserContent(
  workspaceRoot: string,
  content: string,
  fallbackAgent: string = DEFAULT_AGENT_NAME,
): Promise<MessageRouting> {
  const mentioned = leadingMention(content);
  const known = await knownAgentNames(workspaceRoot);
  if (mentioned && known.has(mentioned)) {
    return { mentions: [mentioned], routedTo: [mentioned] };
  }
  const fallback = known.has(fallbackAgent)
    ? fallbackAgent
    : DEFAULT_AGENT_NAME;
  return { mentions: [], routedTo: [fallback] };
}

export async function routeAgentContent(
  workspaceRoot: string,
  content: string,
  authorAgent: string,
  explicitRecipients?: string[],
): Promise<MessageRouting> {
  const known = await knownAgentNames(workspaceRoot);
  const mentioned = leadingMention(content);
  const mentions = mentioned && known.has(mentioned) ? [mentioned] : [];

  if (explicitRecipients) {
    const recipients = [...new Set(explicitRecipients)];
    const unknown = recipients.filter(
      (name) => name !== authorAgent && !known.has(name),
    );
    if (unknown.length > 0) {
      throw new Error(
        `unknown agent${unknown.length === 1 ? "" : "s"}: ${unknown
          .map((name) => `@${name}`)
          .join(", ")}`,
      );
    }
    return {
      mentions,
      routedTo: recipients.filter((name) => name !== authorAgent),
    };
  }

  return {
    mentions,
    routedTo: mentions.filter((name) => name !== authorAgent),
  };
}

async function knownAgentNames(workspaceRoot: string): Promise<Set<string>> {
  const { agents } = await loadAgents(workspaceRoot);
  return new Set(agents.map((agent) => agent.name));
}
