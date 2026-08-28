import { DEFAULT_AGENT_NAME, loadAgents } from "./registry";

export interface MessageRouting {
  mentions: string[];
  routedTo: string[];
  // The subset of routedTo woken by a non-leading mention in a user message.
  // Speculative recipients are shown the message but may legally end their
  // turn without replying; absent (or empty) means every recipient is a
  // deliberate addressee. Only user routing sets this.
  speculative?: string[];
}

// Address-shaped only: the handle must be followed by whitespace, `,`, `:`,
// or the end of the message, so a possessive like "@reviewer's notes" reads
// as prose rather than routing.
const LEADING_MENTION = /^\s*@([a-z0-9][a-z0-9-]*)(?=[\s,:]|$)/;

export function leadingMention(content: string): string | null {
  return content.match(LEADING_MENTION)?.[1] ?? null;
}

// Address-shaped mentions anywhere in the body: preceded by the start,
// whitespace, or an opening bracket, and followed by whitespace, sentence
// punctuation, a closing bracket, or the end — so possessives
// ("@reviewer's") and emails ("a@b.com") stay prose.
const BODY_MENTION = /(?:^|[\s([{])@([a-z0-9][a-z0-9-]*)(?=$|[\s,.:;!?)\]}])/g;

// Known handles mentioned anywhere in `content`, deduplicated in order of
// first appearance.
function knownBodyMentions(content: string, known: Set<string>): string[] {
  const handles = [...content.matchAll(BODY_MENTION)].map((match) => match[1]!);
  return [...new Set(handles)].filter((handle) => known.has(handle));
}

// Known peer handles mentioned anywhere in `content`, excluding the author.
// send_message uses this on messages that routed to nobody: a handoff written
// as prose ("done — @reviewer should look") never wakes anyone, so the send
// result warns the author while there is still a turn left to correct it in.
export async function unroutedPeerMentions(
  workspaceRoot: string,
  content: string,
  authorAgent: string,
): Promise<string[]> {
  const known = await knownAgentNames(workspaceRoot);
  return knownBodyMentions(content, known).filter(
    (handle) => handle !== authorAgent,
  );
}

// Removes the address-shaped leading mention — plus a trailing `,`/`:` and
// whitespace — when it names `handle`; anything else (possessives, other
// handles) is content and comes back unchanged.
export function stripLeadingMention(content: string, handle: string): string {
  const match = content.match(LEADING_MENTION);
  if (!match || match[1] !== handle) {
    return content;
  }
  const rest = content.slice(match[0].length).replace(/^[,:]?\s*/, "");
  return rest.length > 0 ? rest : content;
}

export class ExplicitRecipientRequiredError extends Error {
  readonly code = "EXPLICIT_RECIPIENT_REQUIRED";

  constructor(handle: string) {
    super(
      `EXPLICIT_RECIPIENT_REQUIRED: the message leads with @${handle} but no \`to\` was given. Message text never routes — pass to: ["${handle}"] to hand off, or reword if this is not a handoff.`,
    );
    this.name = "ExplicitRecipientRequiredError";
  }
}

// `fallbackAgent` is the thread's own default — the agent its root message
// routed to — so a thread opened with "@researcher ..." keeps researcher for
// unmentioned replies. A stale fallback (agent since deleted) degrades to the
// workspace default rather than failing the message.
//
// The primary addressee — the leading mention, else the fallback — is always
// routedTo[0] and is expected to reply. Any other known handle mentioned
// anywhere in the body is woken speculatively, Slack-style: the user typed
// the name, so waking is deterministic and legible, but those agents may
// judge the mention a mere reference and stay silent.
export async function routeUserContent(
  workspaceRoot: string,
  content: string,
  fallbackAgent: string = DEFAULT_AGENT_NAME,
): Promise<MessageRouting> {
  const { agents } = await loadAgents(workspaceRoot);
  const known = new Set(agents.map((agent) => agent.name));
  const workspaceDefault =
    agents.find((agent) => agent.role === "default")?.name ?? DEFAULT_AGENT_NAME;
  const mentions = knownBodyMentions(content, known);
  const leading = leadingMention(content);
  const primary =
    leading && known.has(leading)
      ? leading
      : known.has(fallbackAgent)
        ? fallbackAgent
        : workspaceDefault;
  const speculative = mentions.filter((handle) => handle !== primary);
  return {
    mentions,
    routedTo: [primary, ...speculative],
    ...(speculative.length > 0 ? { speculative } : {}),
  };
}

// Doc comments never fall back to the workspace default. Only known mentions
// wake an agent; a leading mention is the required addressee and any other
// mentioned agents are speculative, same as chat.
export async function routeDocCommentContent(
  workspaceRoot: string,
  content: string,
): Promise<MessageRouting> {
  const { agents } = await loadAgents(workspaceRoot);
  const known = new Set(agents.map((agent) => agent.name));
  const mentions = knownBodyMentions(content, known);
  const leading = leadingMention(content);
  const primary = leading && known.has(leading) ? leading : null;
  if (primary) {
    const speculative = mentions.filter((handle) => handle !== primary);
    return {
      mentions,
      routedTo: [primary, ...speculative],
      ...(speculative.length > 0 ? { speculative } : {}),
    };
  }
  if (mentions.length > 0) {
    return { mentions, routedTo: mentions, speculative: mentions };
  }
  return { mentions, routedTo: [] };
}

// Agent messages route only from the structured `to` list; content never
// affects execution, and `mentions` is display metadata. On the send_message
// path, `requireExplicitHandoff` rejects a leading known-agent handle when
// `to` is missing, so a habitual "@reviewer please…" fails loudly instead of
// silently reaching no one. Internal re-derivations (turn-text fallback,
// replays) leave it off: the turn is already over, so there is no sender left
// to correct.
export async function routeAgentContent(
  workspaceRoot: string,
  content: string,
  authorAgent: string,
  explicitRecipients?: string[],
  options: { requireExplicitHandoff?: boolean } = {},
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

  const handle = mentions[0];
  if (options.requireExplicitHandoff && handle && handle !== authorAgent) {
    throw new ExplicitRecipientRequiredError(handle);
  }
  return { mentions, routedTo: [] };
}

async function knownAgentNames(workspaceRoot: string): Promise<Set<string>> {
  const { agents } = await loadAgents(workspaceRoot);
  return new Set(agents.map((agent) => agent.name));
}
