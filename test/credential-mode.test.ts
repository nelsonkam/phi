import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("credential mode configuration", () => {
  test("native mode is the default", () => {
    const previous = process.env.PHI_CREDENTIAL_MODE;
    delete process.env.PHI_CREDENTIAL_MODE;
    try {
      expect(loadConfig().credentialMode).toBe("native");
    } finally {
      if (previous === undefined) delete process.env.PHI_CREDENTIAL_MODE;
      else process.env.PHI_CREDENTIAL_MODE = previous;
    }
  });

  test("isolated mode can be selected explicitly", () => {
    expect(loadConfig({ credentialMode: "isolated" }).credentialMode).toBe(
      "isolated",
    );
  });

  test("invalid environment values fail closed", () => {
    const previous = process.env.PHI_CREDENTIAL_MODE;
    process.env.PHI_CREDENTIAL_MODE = "shared";
    try {
      expect(() => loadConfig()).toThrow(
        "credential mode must be native or isolated",
      );
    } finally {
      if (previous === undefined) delete process.env.PHI_CREDENTIAL_MODE;
      else process.env.PHI_CREDENTIAL_MODE = previous;
    }
  });
});
