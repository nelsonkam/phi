import { EmptyState, Page } from "../app";

export function AgentsPage() {
  return (
    <Page title="Agents">
      <EmptyState message="No agents configured yet." />
    </Page>
  );
}
