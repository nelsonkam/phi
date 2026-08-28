import type { CheckpointService } from "@/core/checkpoints";

export function healthPayload(
  workspaceId: string,
  checkpoints: CheckpointService,
) {
  return {
    ok: checkpoints.health().status === "ok",
    workspaceId,
    checkpoints: checkpoints.health(),
    remote: checkpoints.remoteHealth(),
  };
}
