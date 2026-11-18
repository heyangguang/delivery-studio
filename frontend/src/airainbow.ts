const AI_SURFACE_SEL =
  ".ap-compose, .ad-compose, .rh-compose, .rh-probe-box, .rh-trouble, .ai-pill, .ad-launch, .fc-callai, .fw-chatbtn, .rstep-ai";

let installed = false;

/** Track pointer coordinates across AI cards and pill buttons for 60fps cursor-following multicolor edge light. */
export function installAIRainbowPointer(): void {
  if (
    installed ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  installed = true;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    return;
  }

  let activeChain: HTMLElement[] = [];
  let raf = 0;
  let lastX = 0;
  let lastY = 0;
  let lastTarget: EventTarget | null = null;

  const clearAll = () => {
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    for (const el of activeChain) {
      delete el.dataset.aiPtr;
    }
    activeChain = [];
  };

  const flush = () => {
    raf = 0;
    const base =
      lastTarget instanceof Element
        ? lastTarget
        : lastTarget instanceof Node
          ? lastTarget.parentElement
          : null;

    const nextChain: HTMLElement[] = [];
    let cur: Element | null = base?.closest?.(AI_SURFACE_SEL) ?? null;
    while (cur) {
      if (cur instanceof HTMLElement) {
        nextChain.push(cur);
      }
      cur = cur.parentElement?.closest?.(AI_SURFACE_SEL) ?? null;
    }

    for (const old of activeChain) {
      if (!nextChain.includes(old)) {
        delete old.dataset.aiPtr;
      }
    }

    for (const el of nextChain) {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${(lastX - rect.left).toFixed(1)}px`);
      el.style.setProperty("--my", `${(lastY - rect.top).toFixed(1)}px`);
      el.dataset.aiPtr = "1";
    }

    activeChain = nextChain;
  };

  document.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      lastX = e.clientX;
      lastY = e.clientY;
      lastTarget = e.target;
      if (!raf) {
        raf = window.requestAnimationFrame(flush);
      }
    },
    { passive: true },
  );

  document.addEventListener("pointerleave", clearAll);
  window.addEventListener("blur", clearAll);
}
