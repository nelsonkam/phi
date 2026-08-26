import { cn } from "@/web/lib/utils";

// Each agent's avatar color is derived from a stable hash of its name, so an
// agent keeps one color across sessions, clients, and surfaces. The palette is
// hand-picked: hues spread far apart, lightness tuned so white text stays
// readable on every entry in both themes.
const PALETTE = [
  "hsl(215 68% 48%)", // blue
  "hsl(150 55% 34%)", // green
  "hsl(262 52% 55%)", // violet
  "hsl(24 72% 44%)", // orange
  "hsl(330 60% 46%)", // magenta
  "hsl(175 60% 30%)", // teal
  "hsl(0 62% 50%)", // red
  "hsl(90 45% 34%)", // olive
  "hsl(240 45% 56%)", // indigo
  "hsl(45 85% 33%)", // mustard
  "hsl(195 75% 36%)", // cyan
  "hsl(288 45% 45%)", // purple
] as const;

// FNV-1a: stable, cheap, and spreads short lowercase names well.
export function agentColor(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length]!;
}

const SIZES = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-base",
} as const;

export function AgentAvatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold text-white select-none",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: agentColor(name) }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
