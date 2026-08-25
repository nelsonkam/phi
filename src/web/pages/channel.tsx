import { useParams } from "react-router";
import type { Channel } from "@/shared/types";
import { fetchChannels } from "@/web/lib/api";
import { useEffect, useState } from "react";
import { EmptyState, Page } from "../app";

export function ChannelPage() {
  const { channelId } = useParams();
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    fetchChannels().then(({ channels }) => setChannels(channels));
  }, []);

  const channel = channels.find((c) => c.id === channelId);

  return (
    <Page title={channel ? `# ${channel.name}` : "No channel"}>
      <EmptyState message="No threads yet." />
    </Page>
  );
}
