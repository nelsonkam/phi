import { AlertTriangle, Bot } from "lucide-react";
import type { Agent } from "@/shared/types";
import { useAgents } from "@/web/lib/queries";
import { cn } from "@/web/lib/utils";
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
        <div className="mx-auto w-full max-w-2xl p-4">
          <ul className="divide-y divide-border rounded-lg border">
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
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary">
        <Bot className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">@{agent.name}</p>
        {agent.description && (
          <p className="truncate text-xs text-muted-foreground">
            {agent.description}
          </p>
        )}
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
        {agent.role === "default" && <Badge>default</Badge>}
        <Badge>{agent.harness}</Badge>
        {agent.model && <Badge>{agent.model}</Badge>}
      </div>
    </li>
  );
}

function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
