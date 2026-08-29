import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
// Per-icon Mono components, imported directly. The package barrel
// (`@lobehub/icons`) pulls @lobehub/ui into the bundle and crashes Bun's
// client build; the Mono components themselves only need react.
import ClaudeCodeIcon from "@lobehub/icons/es/ClaudeCode/components/Mono";
import CodexIcon from "@lobehub/icons/es/Codex/components/Mono";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import type {
  HarnessConfig,
  HarnessConfigChoice,
  HarnessConfigOption,
} from "@/shared/types";
import { cn } from "@/web/lib/utils";

export const inputClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring";

export const HARNESS_ICONS: Record<
  string,
  (props: { size?: number }) => React.ReactNode
> = {
  "claude-code": ClaudeCodeIcon,
  cursor: CursorIcon,
  codex: CodexIcon,
};

export function HarnessIcon({ id, size = 16 }: { id: string; size?: number }) {
  const Icon = HARNESS_ICONS[id];
  return Icon ? <Icon size={size} /> : null;
}

// The "model" select from a harness config probe, if the harness has one.
export function modelOption(
  config: HarnessConfig | undefined,
): (HarnessConfigOption & { type: "select" }) | null {
  const option = config?.options?.find(
    (o) => o.category === "model" && o.type === "select",
  );
  return option?.type === "select" ? option : null;
}

// Config options other than the model, in advertised order.
export function otherOptions(
  config: HarnessConfig | undefined,
): HarnessConfigOption[] {
  return (config?.options ?? []).filter((o) => o.category !== "model");
}

export function ModelCombobox({
  choices,
  value,
  onChange,
}: {
  choices: HarnessConfigChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = choices.find((c) => c.value === value);

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
          <span className={cn("truncate", !value && "text-muted-foreground/60")}>
            {selected?.name ?? (value || "Harness default")}
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
              <CommandItem value="__default__" onSelect={() => pick("")}>
                <span className="flex-1">Harness default</span>
                {!value && <Check className="size-4" />}
              </CommandItem>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.value}
                  value={`${choice.name} ${choice.value}`}
                  onSelect={() => pick(choice.value)}
                >
                  <div className="min-w-0 flex-1">
                    <p>{choice.name}</p>
                    {choice.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {choice.description}
                      </p>
                    )}
                  </div>
                  {choice.value === value && (
                    <Check className="size-4 shrink-0" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Renders the non-model config options a harness advertises (effort, fast
// mode, permission mode, ...). Unset values mean the harness default; only
// explicit choices land in `values`.
export function ConfigOptionFields({
  options,
  values,
  onChange,
}: {
  options: HarnessConfigOption[];
  values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean | undefined) => void;
}) {
  if (options.length === 0) return null;
  return (
    <>
      {options.map((option) => (
        <div key={option.id} className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {option.name}
          </label>
          <ConfigOptionField
            option={option}
            value={values[option.id]}
            onChange={(value) => onChange(option.id, value)}
          />
        </div>
      ))}
    </>
  );
}

const UNSET = "__default__";

function ConfigOptionField({
  option,
  value,
  onChange,
}: {
  option: HarnessConfigOption;
  value: string | boolean | undefined;
  onChange: (value: string | boolean | undefined) => void;
}) {
  if (option.type === "boolean") {
    return (
      <Select
        value={value === undefined ? UNSET : String(value)}
        onValueChange={(v) => onChange(v === UNSET ? undefined : v === "true")}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>
            <SelectMuted>Harness default</SelectMuted>
          </SelectItem>
          <SelectItem value="true">On</SelectItem>
          <SelectItem value="false">Off</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <Select
      value={value === undefined ? UNSET : String(value)}
      onValueChange={(v) => onChange(v === UNSET ? undefined : v)}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>
          <SelectMuted>Harness default</SelectMuted>
        </SelectItem>
        {option.choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SelectMuted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
