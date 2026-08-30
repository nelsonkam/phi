import {
  gitRemoteSettings,
  inspectGitRemote,
  parseGitRemoteUrl,
  readGitRemoteConfig,
  writeGitRemoteFile,
} from "@/core/git-remote";
import type { CheckpointService } from "@/core/checkpoints";

export function getGitRemoteSettings(
  root: string,
  checkpoints: CheckpointService,
  env: NodeJS.ProcessEnv = process.env,
): Response {
  return Response.json(
    gitRemoteSettings(root, checkpoints.remoteHealth(), env),
  );
}

export async function putGitRemoteSettings(
  req: Request,
  root: string,
  checkpoints: CheckpointService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (inspectGitRemote(root, env).locked) {
    return Response.json(
      {
        error:
          "PHI_GIT_REMOTE is set; unset it to change the file remote",
      },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || !("url" in body)) {
    return Response.json({ error: "url is required" }, { status: 400 });
  }
  const raw = body.url;
  if (raw !== null && typeof raw !== "string") {
    return Response.json(
      { error: "url must be a string or null" },
      { status: 400 },
    );
  }
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    writeGitRemoteFile(root, null);
  } else {
    const parsed = parseGitRemoteUrl(trimmed);
    if (parsed.kind !== "ok") {
      return Response.json(
        {
          error:
            parsed.kind === "invalid" ? parsed.error : "invalid remote URL",
        },
        { status: 400 },
      );
    }
    writeGitRemoteFile(root, parsed.url);
  }
  checkpoints.configureRemote(readGitRemoteConfig(root, env));
  return Response.json(
    gitRemoteSettings(root, checkpoints.remoteHealth(), env),
  );
}
