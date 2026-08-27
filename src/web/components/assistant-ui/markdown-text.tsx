import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { type FC, memo, useMemo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/web/components/ui/button";
import { FileLink } from "@/web/components/file-link";
import { ExpandableImage } from "@/web/components/image-lightbox";
import { useFileLinkScope } from "@/web/lib/file-link-context";
import {
  fileBasename,
  isWorkspaceHref,
  parseWorkspaceHref,
  resolveLinkedPath,
  workspaceFileUrl,
} from "@/web/lib/file-links";
import { headingIdFromChildren, remarkHeadingIds } from "@/web/lib/heading-ids";
import { remarkMentions } from "@/web/lib/remark-mentions";
import { cn } from "@/web/lib/utils";

// Messages arrive whole (never streamed), so the streaming affordances
// (`smooth` reveal, `defer`) are disabled. `mentionNames` (the loaded agent
// registry) turns valid @mentions into styled pills.
const MarkdownTextImpl = ({
  mentionNames,
}: {
  mentionNames?: ReadonlySet<string>;
}) => {
  const remarkPlugins = useMemo(
    () =>
      mentionNames?.size
        ? [remarkGfm, remarkHeadingIds, remarkMentions(mentionNames)]
        : [remarkGfm, remarkHeadingIds],
    [mentionNames],
  );
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      className="aui-md"
      components={defaultComponents}
      smooth={false}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root border-border/50 bg-muted/50 mt-3 flex items-center justify-between rounded-t-xl border border-b-0 px-3.5 py-1.5 text-xs">
      <span className="aui-code-header-language text-muted-foreground font-medium lowercase">
        {language}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Copy"
        aria-label="Copy code"
        onClick={onCopy}
        className="active:scale-90"
      >
        {!isCopied && (
          <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
        )}
        {isCopied && (
          <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
        )}
      </Button>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    // navigator.clipboard is absent in non-secure contexts (plain-http LAN).
    if (!value || !navigator.clipboard) return;

    navigator.clipboard.writeText(value).then(
      () => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {},
    );
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, id, children, ...props }) => (
    <h1
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h1 mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ className, id, children, ...props }) => (
    <h2
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h2 mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ className, id, children, ...props }) => (
    <h3
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h3 mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ className, id, children, ...props }) => (
    <h4
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h4 mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h4>
  ),
  h5: ({ className, id, children, ...props }) => (
    <h5
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h5 mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h5>
  ),
  h6: ({ className, id, children, ...props }) => (
    <h6
      id={headingIdFromChildren(id, children)}
      className={cn(
        "aui-md-h6 mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    >
      {children}
    </h6>
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-relaxed first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: function MarkdownLink({ className, href, children, ...props }) {
    // A relative href is a workspace file (docs/mcp-tools.md §7). FileLink
    // resolves it against the active channel/root/base-dir scope.
    if (href && isWorkspaceHref(href)) {
      const label =
        typeof children === "string"
          ? children
          : Array.isArray(children) &&
              children.length === 1 &&
              typeof children[0] === "string"
            ? children[0]
            : undefined;
      return <FileLink path={href} label={label} />;
    }
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
          className,
        )}
      >
        {children}
      </a>
    );
  },
  img: function MarkdownImage({ className, src, alt, ...props }) {
    const scope = useFileLinkScope();
    const workspacePath =
      typeof src === "string" && isWorkspaceHref(src)
        ? resolveLinkedPath(
            parseWorkspaceHref(src)?.path ?? src,
            scope.baseDir,
          )
        : undefined;
    const resolvedSrc = workspacePath
      ? workspaceFileUrl(workspacePath, {
          channelId: scope.channelId,
          root: scope.root,
          fragment:
            typeof src === "string"
              ? parseWorkspaceHref(src)?.fragment
              : undefined,
        })
      : src;
    return (
      <ExpandableImage
        {...props}
        src={resolvedSrc}
        alt={alt ?? ""}
        fallbackLabel={workspacePath ? fileBasename(workspacePath) : undefined}
        className={className}
      />
    );
  },
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-3 ms-5 list-disc [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-3 ms-5 list-decimal [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-3", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-3 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li leading-relaxed", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
