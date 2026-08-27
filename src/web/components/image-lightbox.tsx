import { useState, type ComponentProps } from "react";
import { ExternalLink, X } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import { cn } from "@/web/lib/utils";

const HEADER_ACTION_CLASS =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function labelFromSrc(src: string): string | undefined {
  try {
    const base = new URL(src, "http://local.invalid").pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    if (!base) return undefined;
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    return undefined;
  }
}

function imageLabel(
  alt: string | undefined,
  fallbackLabel: string | undefined,
  src: string | undefined,
): string {
  return (
    alt?.trim() ||
    fallbackLabel?.trim() ||
    (src ? labelFromSrc(src) : undefined) ||
    "Image"
  );
}

const thumbnailClassName = "aui-md-img max-h-96 max-w-full rounded-md border";

// Inline markdown / preview image: click (or Enter/Space) opens a larger
// dialog. Same src is reused so the browser cache serves the expanded view.
export function ExpandableImage({
  className,
  src,
  alt,
  fallbackLabel,
  ...props
}: ComponentProps<"img"> & { fallbackLabel?: string }) {
  const [open, setOpen] = useState(false);
  const href = typeof src === "string" ? src : undefined;
  const label = imageLabel(alt, fallbackLabel, href);

  if (!href) {
    return (
      <img
        {...props}
        src={src}
        alt={alt ?? ""}
        className={cn(thumbnailClassName, className)}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Expand ${label}`}
        title="Expand image"
        className="aui-md-img-trigger inline-block max-w-full cursor-zoom-in rounded-md border-0 bg-transparent p-0 text-left align-middle outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <img
          {...props}
          src={src}
          alt={alt ?? ""}
          className={cn(thumbnailClassName, className)}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          overlayClassName="bg-black/50 supports-backdrop-filter:backdrop-blur-sm"
          className="flex w-auto max-w-[98vw] max-h-[96svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[98vw]"
          aria-describedby={undefined}
        >
          <DialogHeader className="shrink-0 border-b px-4 py-2.5">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="flex shrink-0 items-center gap-0.5">
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open original"
                  className={HEADER_ACTION_CLASS}
                >
                  <ExternalLink className="size-3.5" />
                </a>
                <DialogClose title="Close" className={HEADER_ACTION_CLASS}>
                  <X className="size-4" />
                </DialogClose>
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
            <img
              src={src}
              alt={alt ?? ""}
              className="max-h-[calc(96svh-3.5rem)] max-w-full rounded-md object-contain"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
