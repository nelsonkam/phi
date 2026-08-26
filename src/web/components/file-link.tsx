import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { Download, FileText, Maximize2, Minimize2, X } from "lucide-react";
import { MarkdownText } from "@/web/components/assistant-ui/markdown-text";
import { scrollToHeadingFragment } from "@/web/lib/heading-ids";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { FileLinkScope, useFileLinkScope } from "@/web/lib/file-link-context";
import {
  fileBasename,
  fileKind,
  parseFileApiUrl,
  parseWorkspaceHref,
  resolveLinkedPath,
  workspaceDirname,
  workspaceFileUrl,
} from "@/web/lib/file-links";
import { cn } from "@/web/lib/utils";

// A workspace file reference in a message: renders as a chip, opens the file
// in a viewer dialog. `path` is a workspace-style href (already validated by
// the caller); the active FileLinkScope supplies channel, root, and base dir.
export function FileLink({
  path,
  fragment,
  label,
}: {
  path: string;
  fragment?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const scope = useFileLinkScope();
  const parsed = parseWorkspaceHref(path);
  const resolved = resolveLinkedPath(parsed?.path ?? path, scope.baseDir);
  const hash = fragment ?? parsed?.fragment;
  const url = workspaceFileUrl(resolved, {
    channelId: scope.channelId,
    root: scope.root,
    fragment: hash,
  });
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={resolved}
        className="mention inline-flex max-w-full items-center gap-1 align-[-0.14em] transition-colors hover:bg-sky-400/25 dark:hover:bg-sky-400/20"
      >
        <FileText className="size-3 shrink-0 opacity-80" />
        <span className="truncate leading-tight">
          {label ?? fileBasename(resolved)}
        </span>
      </button>
      {open && (
        <FileViewerDialog
          path={resolved}
          url={url}
          fragment={hash}
          channelId={scope.channelId}
          root={scope.root}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const HEADER_ACTION_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function FileViewerDialog({
  path,
  url,
  fragment,
  channelId,
  root,
  onClose,
}: {
  path: string;
  url: string;
  fragment?: string;
  channelId?: string;
  root?: string;
  onClose: () => void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const kind = fileKind(path);
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          fullscreen
            ? "top-0 left-0 h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "max-h-[85svh] sm:max-w-3xl",
        )}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-2.5">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={path}>
              {path}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => setFullscreen((current) => !current)}
                title={fullscreen ? "Exit full screen" : "Full screen"}
                className={HEADER_ACTION_CLASS}
              >
                {fullscreen ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </button>
              <a
                href={url}
                download={fileBasename(path)}
                title="Download"
                className={HEADER_ACTION_CLASS}
              >
                <Download className="size-3.5" />
              </a>
              <DialogClose title="Close" className={HEADER_ACTION_CLASS}>
                <X className="size-4" />
              </DialogClose>
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-24 flex-1 overflow-auto">
          <FileViewerBody
            kind={kind}
            path={path}
            url={url}
            fragment={fragment}
            channelId={channelId}
            root={root}
            fullscreen={fullscreen}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FileViewerBody({
  kind,
  path,
  url,
  fragment,
  channelId,
  root,
  fullscreen,
}: {
  kind: ReturnType<typeof fileKind>;
  path: string;
  url: string;
  fragment?: string;
  channelId?: string;
  root?: string;
  fullscreen: boolean;
}) {
  if (kind === "image") {
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <img src={url} alt={path} className="max-w-full rounded-md" />
      </div>
    );
  }
  // The fullscreen dialog has a definite height, so frames can fill it; the
  // floating dialog sizes to content and needs a fixed frame height.
  const frameClass = cn("w-full", fullscreen ? "h-full" : "h-[70svh]");
  if (kind === "pdf") {
    return <iframe src={url} title={path} className={frameClass} />;
  }
  if (kind === "html") {
    // Static render of untrusted agent output. Containment comes from the
    // serving endpoint's CSP (script-src/connect-src/form-action 'none'), not
    // an iframe sandbox: a sandboxed frame's opaque origin trips Chrome's
    // private-network-access blocking for localhost apps and the page never
    // loads.
    return (
      <iframe src={url} title={path} className={cn(frameClass, "bg-white")} />
    );
  }
  return (
    <TextFileBody
      kind={kind}
      path={path}
      url={url}
      fragment={fragment}
      channelId={channelId}
      root={root}
    />
  );
}

function TextFileBody({
  kind,
  path,
  url,
  fragment,
  channelId,
  root,
}: {
  kind: "markdown" | "text";
  path: string;
  url: string;
  fragment?: string;
  channelId?: string;
  root?: string;
}) {
  const { data, isPending, isError, error } = useQuery({
    // Linked files are live references; always show the current bytes.
    queryKey: ["files", url],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const res = await fetch(url);
      if (res.status === 404) {
        throw new Error("This file no longer exists in the workspace.");
      }
      if (res.status === 409) {
        throw new Error("This path exists in more than one folder.");
      }
      if (!res.ok) throw new Error(`Loading failed (${res.status}).`);
      const type = res.headers.get("content-type") ?? "";
      const binary =
        !type.startsWith("text/") &&
        !type.includes("json") &&
        !type.includes("xml") &&
        !type.includes("javascript");
      const canonical = parseFileApiUrl(res.url);
      if (binary) {
        return {
          binary: true as const,
          root: canonical?.root ?? root,
          path: canonical?.path ?? path,
        };
      }
      return {
        binary: false as const,
        text: await res.text(),
        root: canonical?.root ?? root,
        path: canonical?.path ?? path,
      };
    },
  });

  if (isPending) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }
  if (isError) {
    return <p className="p-4 text-sm text-destructive">{error.message}</p>;
  }
  if (data.binary) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No preview for this file type —{" "}
        <a href={url} download={fileBasename(path)} className="underline">
          download it
        </a>{" "}
        instead.
      </p>
    );
  }
  if (kind === "markdown") {
    return (
      <MarkdownFileView
        text={data.text}
        fragment={fragment}
        channelId={channelId}
        root={data.root}
        baseDir={workspaceDirname(data.path)}
      />
    );
  }
  return (
    <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed whitespace-pre">
      {data.text}
    </pre>
  );
}

// Exported for component tests: heading IDs plus fragment scroll live here,
// not just in the fetch URL.
export function MarkdownFileView({
  text,
  fragment,
  channelId,
  root,
  baseDir,
}: {
  text: string;
  fragment?: string;
  channelId?: string;
  root?: string;
  baseDir?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!fragment || !containerRef.current) return;
    scrollToHeadingFragment(containerRef.current, fragment);
  }, [fragment, text]);
  return (
    <div
      ref={containerRef}
      data-fragment={fragment || undefined}
      className="p-4 text-sm"
    >
      <FileLinkScope channelId={channelId} root={root} baseDir={baseDir}>
        <TextMessagePartProvider text={text}>
          <MarkdownText />
        </TextMessagePartProvider>
      </FileLinkScope>
    </div>
  );
}
