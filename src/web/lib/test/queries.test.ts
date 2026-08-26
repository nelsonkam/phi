import { afterEach, expect, test } from "bun:test";
import type { Channel } from "@/shared/types";
import { queryClient } from "@/web/lib/query-client";
import { applyServerFrame, queryKeys } from "@/web/lib/queries";

afterEach(() => queryClient.clear());

test("channel.updated upserts and sorts the cached channel list", () => {
  const general = channel("ch_general", "general");
  const releases = channel("ch_releases", "releases");
  queryClient.setQueryData(queryKeys.channels, {
    channels: [general, releases],
  });

  const alpha = channel("ch_alpha", "alpha");
  applyServerFrame({ v: 1, type: "channel.updated", channel: alpha });
  applyServerFrame({
    v: 1,
    type: "channel.updated",
    channel: { ...releases, name: "deployments" },
  });

  expect(
    queryClient
      .getQueryData<{ channels: Channel[] }>(queryKeys.channels)
      ?.channels.map((item) => [item.id, item.name]),
  ).toEqual([
    ["ch_alpha", "alpha"],
    ["ch_releases", "deployments"],
    ["ch_general", "general"],
  ]);
});

function channel(id: string, name: string): Channel {
  return {
    id,
    workspaceId: "ws_default",
    name,
    purpose: null,
    folders: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
