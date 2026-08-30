import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import {
  useGitRemoteSettings,
  useUpdateGitRemoteSettings,
} from "@/web/lib/queries";
import { Page, EmptyState } from "../app";

export function SettingsPage() {
  const { data, isPending, isError, error: loadError } = useGitRemoteSettings();

  if (isPending) return <Page title="Settings">{null}</Page>;
  if (isError || !data) {
    return (
      <Page title="Settings">
        <EmptyState
          message={
            loadError instanceof Error
              ? loadError.message
              : "Could not load settings."
          }
        />
      </Page>
    );
  }

  return (
    <Page title="Settings">
      <div className="mx-auto w-full max-w-2xl space-y-8 p-6">
        <GitRemoteSection
          url={data.url}
          locked={data.locked}
          parseError={data.parseError}
          status={data.health.status}
          healthError={data.health.error}
          lastPushedSha={data.health.lastPushedSha}
        />
      </div>
    </Page>
  );
}

function GitRemoteSection({
  url,
  locked,
  parseError,
  status,
  healthError,
  lastPushedSha,
}: {
  url: string | null;
  locked: boolean;
  parseError: string | null;
  status: string;
  healthError: string | null;
  lastPushedSha: string | null;
}) {
  const update = useUpdateGitRemoteSettings();
  const [draft, setDraft] = useState(url ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(url ?? "");
  }, [url]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const error = update.error instanceof Error ? update.error.message : parseError;
  const trimmed = draft.trim();
  const dirty = trimmed !== (url ?? "");

  async function save() {
    try {
      await update.mutateAsync(trimmed || null);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }

  async function clear() {
    try {
      await update.mutateAsync(null);
      setDraft("");
      setSaved(true);
    } catch {
      setSaved(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Git remote</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Optional push-only backup of the workspace undo log. Phi never
          fetches or pulls. One writer per remote.
        </p>
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="git-remote-url"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Remote URL
        </label>
        <Input
          id="git-remote-url"
          className="font-mono text-sm"
          placeholder="git@github.com:you/phi-workspace.git"
          value={draft}
          disabled={locked || update.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !locked && (dirty || status === "degraded")) {
              event.preventDefault();
              void save();
            }
          }}
        />
      </div>
      {locked && (
        <p className="text-xs text-muted-foreground">
          Set by <code className="font-mono">PHI_GIT_REMOTE</code>. Unset that
          environment variable to edit it here.
        </p>
      )}
      <p className="text-xs text-muted-foreground">{statusLabel(status, healthError, lastPushedSha)}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => void save()}
          disabled={locked || update.isPending || (!dirty && status !== "degraded")}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {url && !locked && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void clear()}
            disabled={update.isPending}
          >
            Clear
          </Button>
        )}
        {saved && !error && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <Check className="size-3.5" />
            Saved
          </span>
        )}
      </div>
    </section>
  );
}

function statusLabel(
  status: string,
  healthError: string | null,
  lastPushedSha: string | null,
): string {
  if (status === "unset") return "Not configured.";
  if (status === "pending") return "Pushing the latest checkpoint…";
  if (status === "ok") {
    const short = lastPushedSha?.slice(0, 7);
    return short ? `Last push succeeded (${short}).` : "Last push succeeded.";
  }
  if (status === "degraded") {
    return healthError ? `Push failed: ${healthError}.` : "Push failed.";
  }
  return "";
}
