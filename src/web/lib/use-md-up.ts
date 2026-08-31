import { useEffect, useState } from "react";

const MD_UP = "(min-width: 768px)";

function matchesMdUp(): boolean {
  return window.matchMedia(MD_UP).matches;
}

// Tailwind's `md` breakpoint. Used when CSS alone can't decide (inert,
// autofocus, closing the mobile nav on resize).
export function useMdUp(): boolean {
  const [mdUp, setMdUp] = useState(matchesMdUp);
  useEffect(() => {
    const media = window.matchMedia(MD_UP);
    const onChange = () => setMdUp(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return mdUp;
}
