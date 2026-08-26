import { Link } from "react-router";
import { AlertTriangle, ChevronRight } from "lucide-react";
import type { Agent } from "@/shared/types";
import { AgentAvatar } from "@/web/components/agent-avatar";
import { HarnessIcon } from "@/web/components/harness-fields";
import { useAgents } from "@/web/lib/queries";
import { EmptyState, Page } from "../app";

export function AgentsPage() {
  const { data, isLoading } = useAgents();

  if (isLoading || !data) return <Page title="Agents">{null}</Page>;

  const { agents, errors } = data;

  return (
    <Page title="Agents">
      {agents.length === 0 && errors.length === 0 ? (
        <EmptyState message="No agents yet. Add one at .agents/agents/<name>.md in the workspace." />
      ) : (
        <div className="mx-auto w-full max-w-2xl p-6">
          <p className="mb-3 text-xs text-muted-foreground">
            {agents.length} {agents.length === 1 ? "agent" : "agents"} · defined
            in <code className="font-mono">.agents/agents/</code>
          </p>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border">
            {agents.map((agent) => (
              <AgentRow key={agent.name} agent={agent} />
            ))}
          </ul>
          {errors.map((error) => (
            <p
              key={error.file}
              className="mt-3 flex items-center gap-2 text-xs text-amber-500"
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              {error.file}: {error.message}
            </p>
          ))}
        </div>
      )}
    </Page>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  const configEntries = Object.entries(agent.config);
  return (
    <li>
      <Link
        to={`/agents/${agent.name}`}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
      >
        <AgentAvatar name={agent.name} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            @{agent.name}
            {agent.role === "default" && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                default
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {agent.description ?? "No description"}
          </p>
          {agent.warnings.map((warning) => (
            <p
              key={warning}
              className="mt-0.5 flex items-center gap-1 text-xs text-amber-500"
            >
              <AlertTriangle className="size-3 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            title={agent.harness}
            className="flex size-6 items-center justify-center text-muted-foreground"
          >
            <HarnessIcon id={agent.harness} size={16} />
          </span>
          {agent.model && <Badge>{agent.model}</Badge>}
          {configEntries.length > 0 && (
            <Badge>
              {configEntries.length}{" "}
              {configEntries.length === 1 ? "option" : "options"}
            </Badge>
          )}
          <ChevronRight className="size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
        </div>
      </Link>
    </li>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-40 truncate rounded-md border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}
