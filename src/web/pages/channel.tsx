import { useParams } from "react-router";
import { useChannels } from "@/web/lib/queries";
import { EmptyState, Page } from "../app";

export function ChannelPage() {
  const { channelId } = useParams();
  const { data } = useChannels();
  const channel = data?.channels.find((c) => c.id === channelId);

  return (
    <Page title={channel ? `# ${channel.name}` : "No channel"}>
      <EmptyState message="No threads yet." />
    </Page>
  );
}
