import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Keys } from "./keycap.tsx";

interface Tip {
  text: string;
  keys: string | undefined;
  x: number;
  y: number;
  below: boolean;
}

const DELAY_MS = 500;
const WARM_MS = 1000;

/**
 * Draws every `title` (and `data-tip`) in the app as the system's tooltip (components/tooltip.md), with the
 * element's `data-keys` as its shortcut: after 500ms of hover, at once on keyboard focus, and at once again for 1s
 * after one was shown.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owner: Element | null = null;
    let warmUntil = 0;
    const hide = () => {
      clearTimeout(timer);
      if (owner instanceof HTMLElement && owner.dataset.title) {
        owner.setAttribute("title", owner.dataset.title);
        delete owner.dataset.title;
      }
      if (owner) warmUntil = Date.now() + WARM_MS;
      owner = null;
      setTip(null);
    };
    const show = (event: Event, delay: number) => {
      const element = (event.target as Element | null)?.closest?.("[title], [data-tip]");
      if (!element || element === owner) return;
      hide();
      const text = element.getAttribute("title") ?? element.getAttribute("data-tip") ?? "";
      if (!text) return;
      owner = element;
      if (element instanceof HTMLElement && element.hasAttribute("title")) {
        // The native tooltip would show too: the title waits aside while ours is up.
        element.dataset.title = text;
        element.removeAttribute("title");
      }
      timer = setTimeout(
        () => {
          const box = element.getBoundingClientRect();
          const below = box.top < 40;
          setTip({
            text,
            keys: element.getAttribute("data-keys") ?? undefined,
            x: Math.min(Math.max(box.left + box.width / 2, 150), window.innerWidth - 150),
            y: below ? box.bottom + 6 : box.top - 6,
            below,
          });
        },
        Date.now() < warmUntil ? 0 : delay,
      );
    };
    const over = (event: Event) => show(event, DELAY_MS);
    const focus = (event: Event) => {
      if ((event.target as Element).matches?.(":focus-visible")) show(event, 0);
    };
    const out = (event: Event) => {
      if (owner && !owner.contains((event as PointerEvent).relatedTarget as Node | null)) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <span
      className="tooltip"
      role="tooltip"
      style={{
        position: "fixed",
        left: tip.x,
        top: tip.y,
        bottom: "auto",
        translate: tip.below ? "-50% 0" : "-50% -100%",
      }}
    >
      {tip.text}
      {tip.keys && <Keys shortcut={tip.keys} />}
    </span>,
    document.body,
  );
}
