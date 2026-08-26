import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
// Per-icon Mono components, imported directly. The package barrel
// (`@lobehub/icons`) pulls @lobehub/ui into the bundle and crashes Bun's
// client build; the Mono components themselves only need react.
import ClaudeCodeIcon from "@lobehub/icons/es/ClaudeCode/components/Mono";
import CodexIcon from "@lobehub/icons/es/Codex/components/Mono";
import GeminiCliIcon from "@lobehub/icons/es/GeminiCLI/components/Mono";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/web/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/web/components/ui/popover";
import {
  createDefaultAgent,
  fetchHarnesses,
  fetchHarnessModels,
} from "@/web/lib/api";
import type { CreateDefaultAgentInput } from "@/web/lib/api";
import type { HarnessModel, HarnessStatus } from "@/shared/types";

type ModelsState =
  | { status: "loading" }
  | { status: "ready"; models: HarnessModel[] }
  | { status: "unavailable"; reason: string | null };
import { cn } from "@/web/lib/utils";

const HARNESS_OPTIONS = [
  { value: "claude-code", label: "Claude Code", Icon: ClaudeCodeIcon },
  { value: "gemini", label: "Gemini CLI", Icon: GeminiCliIcon },
  { value: "codex", label: "Codex", Icon: CodexIcon },
] as const;

export function Onboarding() {
  const navigate = useNavigate();
  const [form, setForm] = useState<CreateDefaultAgentInput>({
    harness: "claude-code",
    model: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [harnesses, setHarnesses] = useState<HarnessStatus[]>([]);
  const [modelsState, setModelsState] = useState<ModelsState>({
    status: "unavailable",
    reason: null,
  });

  useEffect(() => {
    fetchHarnesses().then(({ harnesses }) => setHarnesses(harnesses));
  }, []);

  const selectedHarness = harnesses.find((h) => h.id === form.harness);
  const harnessInstalled = selectedHarness?.installed ?? false;

  useEffect(() => {
    if (!harnessInstalled) {
      setModelsState({ status: "unavailable", reason: null });
      return;
    }
    let stale = false;
    setModelsState({ status: "loading" });
    fetchHarnessModels(form.harness)
      .catch((error: Error) => ({ error: error.message }) as const)
      .then((result) => {
        if (stale) return;
        if (result.error !== undefined || result.models.length === 0) {
          setModelsState({
            status: "unavailable",
            reason: result.error ?? null,
          });
        } else {
          setModelsState({ status: "ready", models: result.models });
        }
      });
    return () => {
      stale = true;
    };
  }, [form.harness, harnessInstalled]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createDefaultAgent({
      ...form,
      model: form.model?.trim() || undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    navigate("/", { replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
            φ
          </span>
          <span className="text-sm font-semibold tracking-tight">phi</span>
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
            <Label>Harness</Label>
            <Select
              value={form.harness}
              onValueChange={(harness) =>
                setForm((f) => ({
                  ...f,
                  harness,
                  model: harness === f.harness ? f.model : "",
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HARNESS_OPTIONS.map(({ value, label, Icon }) => {
                  const status = harnesses.find((h) => h.id === value);
                  return (
                    <SelectItem
                      key={value}
                      value={value}
                      className="[&>span:last-child]:w-full"
                    >
                      <span className="flex w-full items-center gap-2">
                        <Icon size={16} />
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
              <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-3.5 text-xs">
                <p className="flex items-center gap-2 font-medium text-amber-500">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  {selectedHarness.name} is not installed on this machine.
                </p>
                <p className="mt-3 text-muted-foreground">
                  Install it, then come back:
                </p>
                <code className="mt-1.5 block rounded-md bg-secondary px-2.5 py-2 font-mono text-muted-foreground">
                  {selectedHarness.installHint}
                </code>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Model</Label>
            {modelsState.status === "ready" ? (
              <ModelCombobox
                models={modelsState.models}
                value={form.model ?? ""}
                onChange={(model) => setForm((f) => ({ ...f, model }))}
              />
            ) : (
              <>
                <div className="relative">
                  <Input
                    placeholder="Leave empty for the harness default"
                    disabled={modelsState.status === "loading"}
                    value={form.model ?? ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, model: e.target.value }))
                    }
                  />
                  {modelsState.status === "loading" && (
                    <LoaderCircle className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  )}
                </div>
                {modelsState.status === "unavailable" && modelsState.reason && (
                  <p className="text-xs text-muted-foreground/60">
                    Could not list models: {modelsState.reason}
                  </p>
                )}
              </>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create agent"}
            {!submitting && <ArrowRight className="size-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}

function ModelCombobox({
  models,
  value,
  onChange,
}: {
  models: HarnessModel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.find((m) => m.id === value);

  function pick(model: string) {
    onChange(model);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(inputClass, "flex items-center justify-between gap-2")}
        >
          <span className={cn(!value && "text-muted-foreground/60")}>
            {selected?.name ?? value}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput
            placeholder="Search models…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty className="p-1">
              <button
                type="button"
                onClick={() => pick(query)}
                className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                Use “{query}”
              </button>
            </CommandEmpty>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={`${model.name} ${model.id}`}
                  onSelect={() => pick(model.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p>{model.name}</p>
                    {model.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {model.description}
                      </p>
                    )}
                  </div>
                  {model.id === value && <Check className="size-4 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring";

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, props.className)} />;
}
