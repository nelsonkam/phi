import { EmptyState, Page } from "../app";

export function InboxPage() {
  return (
    <Page title="Inbox">
      <EmptyState message="Nothing needs your attention." />
    </Page>
  );
}
