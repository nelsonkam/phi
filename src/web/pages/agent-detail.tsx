import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import type { Agent } from "@/shared/types";
import {
  ConfigOptionFields,
  HarnessIcon,
  ModelCombobox,
  inputClass,
  modelOption,
  otherOptions,
} from "@/web/components/harness-fields";
import {
  useAgent,
  useHarnessConfig,
  useHarnesses,
  useUpdateAgent,
} from "@/web/lib/queries";
import { cn } from "@/web/lib/utils";
import { EmptyState, Page } from "../app";

interface Draft {
  description: string;
  model: string;
  config: Record<string, string | boolean>;
  instructions: string;
}

export function AgentDetailPage() {
  const { name = "" } = useParams();
  const { data, isPending, isError } = useAgent(name);

  if (isPending) return <Page title={`@${name}`}>{null}</Page>;
  if (isError || !data) {
    return (
      <Page title={`@${name}`}>
        <EmptyState message={`No agent named "${name}".`} />
      </Page>
    );
  }
  return <AgentEditor agent={data.agent} />;
}

function AgentEditor({ agent }: { agent: Agent & { instructions: string } }) {
  const [draft, setDraft] = useState<Draft>({
    description: agent.description ?? "",
    model: agent.model ?? "",
    config: agent.config,
    instructions: agent.instructions,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the draft when the server copy changes (e.g. after save).
  useEffect(() => {
    setDraft({
      description: agent.description ?? "",
      model: agent.model ?? "",
      config: agent.config,
      instructions: agent.instructions,
    });
  }, [agent]);

  const { data: harnessData } = useHarnesses();
  const harness = harnessData?.harnesses.find((h) => h.id === agent.harness);
  const configQuery = useHarnessConfig(agent.harness, harness?.installed ?? false);
  const harnessConfig = harness?.installed ? configQuery.data : undefined;
  const models = modelOption(harnessConfig);

  const update = useUpdateAgent(agent.name);

  async function save() {
    setError(null);
    setSaved(false);
    const result = await update.mutateAsync({
      harness: agent.harness,
      description: draft.description.trim() || undefined,
      model: draft.model.trim() || undefined,
      config: draft.config,
      instructions: draft.instructions,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Page title={`@${agent.name}`}>
      <div className="mx-auto w-full max-w-2xl p-6">
        <Link
          to="/agents"
          className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All agents
        </Link>

        <header className="mb-6 flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
            <HarnessIcon id={agent.harness} size={22} />
          </span>
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              @{agent.name}
              {agent.role === "default" && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                  default
                </span>
              )}
            </h2>
            <p className="text-xs text-muted-foreground">
              {harness?.name ?? agent.harness}
              {harness && !harness.installed && " · not installed"}
            </p>
          </div>
        </header>

        {agent.warnings.map((warning) => (
          <p
            key={warning}
            className="mb-4 flex items-center gap-2 text-xs text-amber-500"
          >
            <TriangleAlert className="size-3.5 shrink-0" />
            {warning}
          </p>
        ))}

        <div className="space-y-5">
          <Field label="Description">
            <input
              className={inputClass}
              placeholder="What this agent is for"
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
            />
          </Field>

          <Field label="Model">
            {models ? (
              <ModelCombobox
                choices={models.choices}
                value={draft.model}
                onChange={(model) => setDraft((d) => ({ ...d, model }))}
              />
            ) : (
              <input
                className={inputClass}
                placeholder="Leave empty for the harness default"
                value={draft.model}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, model: e.target.value }))
                }
              />
            )}
          </Field>

          <ConfigOptionFields
            options={otherOptions(harnessConfig)}
            values={draft.config}
            onChange={(id, value) =>
              setDraft((d) => {
                const next = { ...d.config };
                if (value === undefined) delete next[id];
                else next[id] = value;
                return { ...d, config: next };
              })
            }
          />

          <Field label="Instructions">
            <textarea
              rows={10}
              className={cn(inputClass, "resize-y font-mono text-xs leading-relaxed")}
              value={draft.instructions}
              onChange={(e) =>
                setDraft((d) => ({ ...d, instructions: e.target.value }))
              }
            />
          </Field>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={update.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {update.isPending ? "Saving…" : "Save changes"}
            </button>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <Check className="size-3.5" />
                Saved
              </span>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
