import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// A reader is "pinned" while this close to the bottom; scrolling further up
// releases the pin so new content stops yanking them down.
const PIN_THRESHOLD_PX = 48;
// Smooth autoscrolls finish well inside this window; after it, scroll events
// are treated as the reader's own again even if the animation never landed
// (hidden tab, interrupted animation).
const FOLLOW_WINDOW_MS = 800;

// Chat-style scroll anchoring: follow new content only while the reader is at
// the bottom. `itemCount` growing scrolls smoothly when pinned and raises
// `hasNew` when not; `resetKey` changing (switching thread/channel) jumps to
// the bottom instantly and re-pins. Spread `scrollProps` onto the scrollable
// container.
export function useStickToBottom(itemCount: number, resetKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // While we drive a smooth autoscroll, intermediate scroll events read as
  // "not at the bottom" and must not unpin; deliberate reader input (wheel,
  // touch) or this deadline passing hands scrolling back to the reader.
  const followingUntil = useRef(0);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = containerRef.current;
    if (!container) return;
    pinnedRef.current = true;
    followingUntil.current =
      behavior === "smooth" ? performance.now() + FOLLOW_WINDOW_MS : 0;
    setPinned(true);
    setHasNew(false);
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    scrollToBottom("instant");
  }, [resetKey, scrollToBottom]);

  const prevCount = useRef(itemCount);
  useEffect(() => {
    if (itemCount === prevCount.current) return;
    const grew = itemCount > prevCount.current;
    // The first batch is the history fetch landing, not new activity: jump
    // straight to the bottom instead of animating past every old message.
    const initialLoad = prevCount.current === 0;
    prevCount.current = itemCount;
    if (!grew) return;
    if (pinnedRef.current) {
      scrollToBottom(initialLoad ? "instant" : "smooth");
    } else {
      setHasNew(true);
    }
  }, [itemCount, scrollToBottom]);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      PIN_THRESHOLD_PX;
    if (performance.now() < followingUntil.current) {
      if (nearBottom) followingUntil.current = 0;
      return;
    }
    pinnedRef.current = nearBottom;
    setPinned(nearBottom);
    if (nearBottom) setHasNew(false);
  }, []);

  // Wheel and touch are unambiguous reader intent: cancel any follow window
  // so the very next scroll event can unpin.
  const onReaderInput = useCallback(() => {
    followingUntil.current = 0;
  }, []);

  const scrollProps = useMemo(
    () => ({
      ref: containerRef,
      onScroll,
      onWheel: onReaderInput,
      onTouchMove: onReaderInput,
    }),
    [onScroll, onReaderInput],
  );

  return { scrollProps, pinned, hasNew, scrollToBottom };
}
