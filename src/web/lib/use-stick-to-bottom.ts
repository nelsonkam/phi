import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// A reader is "pinned" while this close to the bottom; scrolling further up
// releases the pin so new content stops yanking them down.
const PIN_THRESHOLD_PX = 48;
// Smooth autoscrolls finish well inside this window; after it, scroll events
// are treated as the reader's own again even if the animation never landed
// (hidden tab, interrupted animation).
const FOLLOW_WINDOW_MS = 800;

// Growing content (a new message, or the working-row expand) sticks when the
// reader is pinned and only raises the jump badge when they have scrolled away.
export function followContentHeight(
  prevHeight: number,
  nextHeight: number,
  pinned: boolean,
): "stick" | "hasNew" | "ignore" {
  if (nextHeight <= prevHeight) return "ignore";
  return pinned ? "stick" : "hasNew";
}

// Queue growth shrinks the message viewport without changing content
// height. Keep the last messages in view while the reader is pinned.
export function followContainerShrink(
  prevClientHeight: number,
  nextClientHeight: number,
  pinned: boolean,
): "stick" | "ignore" {
  if (nextClientHeight >= prevClientHeight) return "ignore";
  return pinned ? "stick" : "ignore";
}

// Chat-style scroll anchoring: follow new content only while the reader is at
// the bottom. `itemCount` growing scrolls smoothly when pinned and raises
// `hasNew` when not; `resetKey` changing (switching thread/channel) jumps to
// the bottom instantly and re-pins. Attach `contentRef` to an inner wrapper
// so height-only growth (the working-row 0fr→1fr transition) is followed too
// — `itemCount` does not change when that row expands. Spread `scrollProps`
// onto the scrollable container.
export function useStickToBottom(itemCount: number, resetKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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

  // The working row grows without changing `itemCount`; the follow-up queue
  // shrinks this viewport the same way. Snap rather than smooth-scroll so a
  // 200ms CSS expand (or queue insert) is tracked each frame.
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastHeight = content.offsetHeight;
    let lastClient = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = content.offsetHeight;
      const nextClient = container.clientHeight;
      const contentAction = followContentHeight(
        lastHeight,
        nextHeight,
        pinnedRef.current,
      );
      const viewportAction = followContainerShrink(
        lastClient,
        nextClient,
        pinnedRef.current,
      );
      lastHeight = nextHeight;
      lastClient = nextClient;
      if (contentAction === "stick" || viewportAction === "stick") {
        container.scrollTop = container.scrollHeight;
      } else if (contentAction === "hasNew") {
        setHasNew(true);
      }
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [resetKey]);

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

  return { scrollProps, contentRef, pinned, hasNew, scrollToBottom };
}
