import { useEffect } from "react";
import { useLocation } from "wouter";

/** Restore native fragment navigation after React has committed the target. */
export default function AnchorNavigation() {
  const [location] = useLocation();
  useEffect(() => {
    const header = document.querySelector(".fn-nav");
    const measureHeader = () => {
      document.documentElement.style.setProperty(
        "--anchor-offset",
        `${Math.ceil(header?.getBoundingClientRect().height ?? 80) + 16}px`,
      );
    };
    measureHeader();
    const resize = new ResizeObserver(measureHeader);
    if (header) resize.observe(header);
    let cancelJump = () => {};
    const reveal = (event?: Event) => {
      cancelJump();
      if (!window.location.hash) return;
      const hash = window.location.hash;
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      let stopped = false;
      let frame = 0;
      let observer: MutationObserver | undefined;
      const timer = window.setTimeout(() => stop(), 5000);
      function stop() {
        stopped = true;
        window.clearTimeout(timer);
        cancelAnimationFrame(frame);
        observer?.disconnect();
      }
      cancelJump = stop;
      const align = () => {
        if (stopped || window.location.hash !== hash) return;
        const target = document.getElementById(id);
        if (!target) return;
        observer?.disconnect();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            if (stopped) return;
            measureHeader();
            target.scrollIntoView({
              block: "start",
              behavior:
                event &&
                !window.matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "smooth"
                  : "instant",
            });
          });
        });
      };
      observer = new MutationObserver(align);
      observer.observe(document.body, { childList: true, subtree: true });
      align();
      // Web fonts can change layout after the first committed frame.
      void document.fonts.ready.then(align);
    };
    const interrupt = () => cancelJump();
    reveal();
    window.addEventListener("hashchange", reveal);
    window.addEventListener("popstate", reveal);
    window.addEventListener("wheel", interrupt, { passive: true });
    window.addEventListener("touchstart", interrupt, { passive: true });
    window.addEventListener("pointerdown", interrupt);
    window.addEventListener("keydown", interrupt);
    return () => {
      cancelJump();
      resize.disconnect();
      window.removeEventListener("hashchange", reveal);
      window.removeEventListener("popstate", reveal);
      window.removeEventListener("wheel", interrupt);
      window.removeEventListener("touchstart", interrupt);
      window.removeEventListener("pointerdown", interrupt);
      window.removeEventListener("keydown", interrupt);
    };
  }, [location]);
  return null;
}
