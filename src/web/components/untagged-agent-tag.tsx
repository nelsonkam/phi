import { Link } from "react-router";

// Compact handle chip for the agent that takes untagged messages.
export function UntaggedAgentTag({ name }: { name: string }) {
  return (
    <Link
      to={`/agents/${name}`}
      title="Answers messages that do not start with @name"
      className="mention shrink-0 text-[11px] leading-5"
    >
      @{name}
    </Link>
  );
}
