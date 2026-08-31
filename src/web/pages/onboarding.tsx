import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, LoaderCircle, TriangleAlert } from "lucide-react";
import { ThemeToggle } from "@/web/components/theme-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  ConfigOptionFields,
  HarnessIcon,
  ModelCombobox,
  inputClass,
  modelOption,
  otherOptions,
} from "@/web/components/harness-fields";
import {
  useCreateDefaultAgent,
  useHarnessConfig,
  useHarnesses,
} from "@/web/lib/queries";
import type { CreateDefaultAgentInput } from "@/web/lib/api";
import { cn } from "@/web/lib/utils";

export function Onboarding() {
  const navigate = useNavigate();
  const [form, setForm] = useState<CreateDefaultAgentInput>({
    name: "default",
    harness: "claude-code",
    model: "",
    config: {},
  });
  const [error, setError] = useState<string | null>(null);
  const { data: harnessData } = useHarnesses();
  const harnesses = harnessData?.harnesses ?? [];

  useEffect(() => {
    if (
      harnesses.length > 0 &&
      !harnesses.some((harness) => harness.id === form.harness)
    ) {
      setForm((f) => ({
        ...f,
        harness: harnesses[0]!.id,
        model: "",
        config: {},
      }));
    }
  }, [form.harness, harnesses]);

  const selectedHarness = harnesses.find((h) => h.id === form.harness);
  const harnessInstalled = selectedHarness?.installed ?? false;

  const configQuery = useHarnessConfig(form.harness, harnessInstalled);
  const config = harnessInstalled ? configQuery.data : undefined;
  const configLoading = harnessInstalled && configQuery.isPending;
  const models = modelOption(config);

  const createAgent = useCreateDefaultAgent();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result = await createAgent.mutateAsync({
      ...form,
      name: form.name?.trim() || undefined,
      model: form.model?.trim() || undefined,
      config: Object.keys(form.config ?? {}).length ? form.config : undefined,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2.5">
          <img
            src="/favicon.png"
            alt=""
            width={28}
            height={28}
            className="size-7 rounded-md ring-1 ring-border"
          />
          <span className="text-sm font-semibold tracking-tight">phi</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <h1 className="text-lg font-semibold tracking-tight">
          Set up your default agent
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This agent coordinates your work. You can change it later at any
          time.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-5">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                @
              </span>
              <input
                required
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                // Escape the hyphen; HTML pattern attributes use the unicode v flag.
                pattern={"[a-z0-9][a-z0-9\\-]*"}
                title="lowercase letters, numbers, and hyphens"
                placeholder="default"
                className={cn(inputClass, "pl-7")}
                value={form.name ?? ""}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    name: e.target.value.toLowerCase(),
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Harness</Label>
            <Select
              value={form.harness}
              onValueChange={(harness) =>
                setForm((f) =>
                  harness === f.harness
                    ? f
                    : { ...f, harness, model: "", config: {} },
                )
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {harnesses.map((status) => {
                  const value = status.id;
                  const label = status.name;
                  return (
                    <SelectItem
                      key={value}
                      value={value}
                      className="[&>span:last-child]:w-full"
                    >
                      <span className="flex w-full items-center gap-2">
                        <HarnessIcon id={value} />
                        {label}
                        {status && !status.installed && (
                          <span className="ml-auto text-xs text-muted-foreground/60">
                            not installed
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {selectedHarness && !selectedHarness.installed && (
              <HintBox
                headline={`${selectedHarness.name} is not installed on this machine.`}
                lead="Install it, then come back:"
                command={selectedHarness.installHint}
              />
            )}
            {config?.error && (
              <HintBox
                headline={`${config.error}.`}
                lead={config.loginHint ? "Log in, then come back:" : null}
                command={config.loginHint ?? null}
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Model</Label>
            {models ? (
              <ModelCombobox
                choices={models.choices}
                value={form.model ?? ""}
                onChange={(model) => setForm((f) => ({ ...f, model }))}
              />
            ) : (
              <div className="relative">
                <input
                  placeholder="Leave empty for the harness default"
                  disabled={configLoading}
                  className={inputClass}
                  value={form.model ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, model: e.target.value }))
                  }
                />
                {configLoading && (
                  <LoaderCircle className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>
            )}
          </div>

          <ConfigOptionFields
            options={otherOptions(config)}
            values={form.config ?? {}}
            onChange={(id, value) =>
              setForm((f) => {
                const next = { ...(f.config ?? {}) };
                if (value === undefined) delete next[id];
                else next[id] = value;
                return { ...f, config: next };
              })
            }
          />

          {error && <p className="text-xs text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={createAgent.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {createAgent.isPending ? "Creating…" : "Create agent"}
            {!createAgent.isPending && <ArrowRight className="size-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

function HintBox({
  headline,
  lead,
  command,
}: {
  headline: string;
  lead: string | null;
  command: string | null;
}) {
  return (
    <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-3.5 text-xs">
      <p className="flex items-center gap-2 font-medium text-amber-500">
        <TriangleAlert className="size-3.5 shrink-0" />
        {headline}
      </p>
      {lead && <p className="mt-3 text-muted-foreground">{lead}</p>}
      {command && (
        <code className="mt-1.5 block rounded-md bg-secondary px-2.5 py-2 font-mono text-muted-foreground">
          {command}
        </code>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "text-xs font-medium uppercase tracking-wide text-muted-foreground",
      )}
    >
      {children}
    </label>
  );
}
