import { listHarnessConfig } from "./config";
import { detectHarnesses } from "./harnesses";
import type {
  HarnessConfig,
  HarnessConfigOption,
  HarnessStatus,
} from "@/shared/types";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export type AgentHarnessConfigOption =
  | {
      id: string;
      type: "select";
      defaultValue: string;
      values: string[];
    }
  | {
      id: string;
      type: "boolean";
      defaultValue: boolean;
    };

export interface AgentHarnessCapability {
  id: string;
  name: string;
  installed: boolean;
  available: boolean;
  installHint: string;
  loginHint?: string;
  models: string[] | null;
  defaultModel: string | null;
  configOptions: AgentHarnessConfigOption[];
  error?: string;
}

export interface AgentHarnessCapabilityList {
  harnesses: AgentHarnessCapability[];
}

interface HarnessCapabilityServiceOptions {
  cacheTtlMs?: number;
  detect?: () => HarnessStatus[];
  probe?: (harnessId: string, cwd: string) => Promise<HarnessConfig>;
  now?: () => number;
}

export class HarnessCapabilityService {
  private readonly cache = new Map<
    string,
    { at: number; result: Promise<HarnessConfig> }
  >();
  private readonly cacheTtlMs: number;
  private readonly detect: () => HarnessStatus[];
  private readonly probe: (
    harnessId: string,
    cwd: string,
  ) => Promise<HarnessConfig>;
  private readonly now: () => number;

  constructor(
    private readonly workspaceRoot: string,
    options: HarnessCapabilityServiceOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.detect = options.detect ?? detectHarnesses;
    this.probe = options.probe ?? listHarnessConfig;
    this.now = options.now ?? Date.now;
  }

  getConfig(harnessId: string): Promise<HarnessConfig> {
    const cached = this.cache.get(harnessId);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      return cached.result;
    }

    const result = this.probe(harnessId, this.workspaceRoot).then((config) => {
      // Authentication and launch failures may be fixed immediately, so do
      // not retain them for the full cache window.
      if (config.error) this.cache.delete(harnessId);
      return config;
    });
    this.cache.set(harnessId, { at: this.now(), result });
    return result;
  }

  async list(harnessId?: string): Promise<AgentHarnessCapabilityList> {
    const statuses = this.detect();
    const selected = harnessId
      ? statuses.filter((status) => status.id === harnessId)
      : statuses;
    if (harnessId && selected.length === 0) {
      throw new Error(`unknown harness "${harnessId}"`);
    }

    return {
      harnesses: await Promise.all(
        selected.map((status) => this.capability(status)),
      ),
    };
  }

  private async capability(
    status: HarnessStatus,
  ): Promise<AgentHarnessCapability> {
    if (!status.installed) {
      return {
        ...status,
        available: false,
        models: null,
        defaultModel: null,
        configOptions: [],
        error: `${status.name} is not installed`,
      };
    }

    const config = await this.getConfig(status.id);
    if (config.error) {
      return {
        ...status,
        available: false,
        models: null,
        defaultModel: null,
        configOptions: [],
        error: config.error,
        ...(config.loginHint ? { loginHint: config.loginHint } : {}),
      };
    }

    const options = config.options ?? [];
    const model = options.find(
      (option) => option.category === "model" && option.type === "select",
    );
    return {
      ...status,
      available: true,
      models:
        model?.type === "select"
          ? model.choices.map((choice) => choice.value)
          : [],
      defaultModel: model?.type === "select" ? model.currentValue : null,
      configOptions: options
        .filter((option) => option !== model)
        .map(agentConfigOption),
    };
  }
}

function agentConfigOption(
  option: HarnessConfigOption,
): AgentHarnessConfigOption {
  if (option.type === "boolean") {
    return {
      id: option.id,
      type: "boolean",
      defaultValue: option.currentValue,
    };
  }
  return {
    id: option.id,
    type: "select",
    defaultValue: option.currentValue,
    values: option.choices.map((choice) => choice.value),
  };
}
