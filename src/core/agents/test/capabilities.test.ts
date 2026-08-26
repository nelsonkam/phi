import { expect, test } from "bun:test";
import { HarnessCapabilityService } from "@/core/agents/capabilities";
import type { HarnessConfig, HarnessStatus } from "@/shared/types";

const STATUSES: HarnessStatus[] = [
  {
    id: "codex",
    name: "Codex",
    installed: true,
    installHint: "install codex",
  },
  {
    id: "cursor",
    name: "Cursor CLI",
    installed: false,
    installHint: "install cursor",
  },
];

const CONFIG: HarnessConfig = {
  options: [
    {
      id: "model-picker",
      name: "Model",
      description: null,
      category: "model",
      type: "select",
      currentValue: "gpt-default",
      choices: [
        { value: "gpt-default", name: "Default", description: null },
        { value: "gpt-fast", name: "Fast", description: null },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      description: null,
      category: "thought",
      type: "select",
      currentValue: "medium",
      choices: [
        { value: "low", name: "Low", description: null },
        { value: "medium", name: "Medium", description: null },
      ],
    },
    {
      id: "fast",
      name: "Fast mode",
      description: null,
      category: null,
      type: "boolean",
      currentValue: false,
    },
  ],
};

test("returns verbatim ACP values and does not probe uninstalled harnesses", async () => {
  const probes: string[] = [];
  const service = new HarnessCapabilityService("/workspace", {
    detect: () => STATUSES,
    probe: async (id) => {
      probes.push(id);
      return CONFIG;
    },
  });

  expect(await service.list()).toEqual({
    harnesses: [
      {
        ...STATUSES[0]!,
        available: true,
        models: ["gpt-default", "gpt-fast"],
        defaultModel: "gpt-default",
        configOptions: [
          {
            id: "effort",
            type: "select",
            defaultValue: "medium",
            values: ["low", "medium"],
          },
          { id: "fast", type: "boolean", defaultValue: false },
        ],
      },
      {
        ...STATUSES[1]!,
        available: false,
        models: null,
        defaultModel: null,
        configOptions: [],
        error: "Cursor CLI is not installed",
      },
    ],
  });
  expect(probes).toEqual(["codex"]);
});

test("supports one-harness lookup and shares successful probes", async () => {
  let probes = 0;
  const service = new HarnessCapabilityService("/workspace", {
    detect: () => STATUSES,
    probe: async () => {
      probes += 1;
      return CONFIG;
    },
  });

  expect((await service.list("codex")).harnesses).toHaveLength(1);
  await service.getConfig("codex");
  expect(probes).toBe(1);
  await expect(service.list("missing")).rejects.toThrow(
    'unknown harness "missing"',
  );
});

test("surfaces per-harness probe errors without failing the list", async () => {
  const service = new HarnessCapabilityService("/workspace", {
    detect: () => STATUSES.slice(0, 1),
    probe: async () => ({
      error: "Codex is not logged in on this machine",
      loginHint: "codex login",
    }),
  });

  expect((await service.list()).harnesses[0]).toMatchObject({
    id: "codex",
    installed: true,
    available: false,
    models: null,
    error: "Codex is not logged in on this machine",
    loginHint: "codex login",
  });
});
