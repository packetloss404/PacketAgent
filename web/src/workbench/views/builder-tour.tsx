import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { markBuilderTourSeen, readBuilderTourSeen } from "./builder-tour-state";

/**
 * First-run guided tour for `/builder`.
 *
 * Renders a sequence of 5 tooltip-style callouts anchored to existing UI
 * elements (located via `data-tour="..."` attributes on those elements).
 * Persists a "seen" flag in localStorage so the tour only fires once.
 *
 * The tour gracefully skips steps whose anchor isn't currently in the DOM
 * (e.g. the post-draft Preview tab is hidden in the empty cold-start state)
 * so the tour can be useful both before and after the user has built an app.
 *
 * To re-trigger the tour after dismissal, a host page can clear the localStorage
 * flag with `BuilderTour.reset()` and remount the component. The empty-state
 * cold-start screen in `builder.tsx` exposes a small "Show tour" link that does
 * this for users who want to revisit the walkthrough.
 */
interface TourStep {
  anchor: string;
  title: string;
  body: string;
  placement?: "bottom" | "top" | "right" | "left";
}

const STEPS: TourStep[] = [
  {
    anchor: "composer",
    title: "Describe what you want to build",
    body: "Type a prompt like 'a kanban board for tracking renewals' — or pick an example below to get started.",
    placement: "bottom",
  },
  {
    anchor: "chips",
    title: "Or start from an example",
    body: "Click a chip to fill in a starter prompt. You can edit it before hitting Build.",
    placement: "top",
  },
  {
    anchor: "presets",
    title: "Pick a speed / quality preset",
    body: "Lightning is fast and cheap. Smart uses a bigger model. Local uses your own LLM if you have one running.",
    placement: "top",
  },
  {
    anchor: "preview-tab",
    title: "See your app come alive",
    body: "Once it's built, the Preview tab shows the running app. Hold ⌘ or Ctrl and click any element to scope your next change.",
    placement: "bottom",
  },
  {
    anchor: "checkpoints",
    title: "Every change is saved",
    body: "Open the Saves tab to jump back to any previous version. The 'Revert to here' button on any chat message also works.",
    placement: "bottom",
  },
];

function findAnchor(name: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
}

interface CalloutPosition {
  top: number;
  left: number;
  anchorTop: number;
  anchorLeft: number;
  anchorWidth: number;
  anchorHeight: number;
}

const CALLOUT_WIDTH = 320;
const CALLOUT_GAP = 14;

function computePosition(
  rect: DOMRect,
  placement: TourStep["placement"],
  calloutHeight: number,
): CalloutPosition {
  const margin = 8;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  let top: number;
  let left: number;

  switch (placement ?? "bottom") {
    case "top":
      top = rect.top - calloutHeight - CALLOUT_GAP;
      left = rect.left + rect.width / 2 - CALLOUT_WIDTH / 2;
      break;
    case "right":
      top = rect.top + rect.height / 2 - calloutHeight / 2;
      left = rect.right + CALLOUT_GAP;
      break;
    case "left":
      top = rect.top + rect.height / 2 - calloutHeight / 2;
      left = rect.left - CALLOUT_WIDTH - CALLOUT_GAP;
      break;
    case "bottom":
    default:
      top = rect.bottom + CALLOUT_GAP;
      left = rect.left + rect.width / 2 - CALLOUT_WIDTH / 2;
      break;
  }

  // Clamp to viewport so the callout never escapes off-screen even when
  // anchors are small or near an edge.
  if (left + CALLOUT_WIDTH > winW - margin) left = winW - CALLOUT_WIDTH - margin;
  if (left < margin) left = margin;
  if (top + calloutHeight > winH - margin) top = winH - calloutHeight - margin;
  if (top < margin) top = margin;

  return {
    top,
    left,
    anchorTop: rect.top,
    anchorLeft: rect.left,
    anchorWidth: rect.width,
    anchorHeight: rect.height,
  };
}

export function BuilderTour(): ReactElement | null {
  // Track localStorage state in component state so the "Show tour" re-trigger
  // (which clears the flag) can re-mount us cleanly via the key prop, but
  // even within the same mount Skip should immediately unmount.
  const [active, setActive] = useState<boolean>(() => !readBuilderTourSeen());
  const [stepIndex, setStepIndex] = useState(0);
  const [position, setPosition] = useState<CalloutPosition | null>(null);
  const calloutRef = useRef<HTMLDivElement | null>(null);
  const [, forceRender] = useState(0);

  const visibleSteps = useMemo(() => STEPS, []);

  const dismiss = useCallback(() => {
    markBuilderTourSeen();
    setActive(false);
  }, []);

  const advance = useCallback(() => {
    setStepIndex((prev) => {
      // Search forward for the next step whose anchor exists. If none, finish.
      for (let i = prev + 1; i < visibleSteps.length; i++) {
        const step = visibleSteps[i]!;
        if (findAnchor(step.anchor)) return i;
      }
      // No further visible steps — mark complete.
      markBuilderTourSeen();
      setActive(false);
      return prev;
    });
  }, [visibleSteps]);

  // On mount, advance past any leading steps whose anchor isn't present.
  // This keeps the empty-state tour from getting stuck pointing at a hidden
  // Preview tab.
  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      setStepIndex((prev) => {
        for (let i = prev; i < visibleSteps.length; i++) {
          const step = visibleSteps[i]!;
          if (findAnchor(step.anchor)) return i;
        }
        // Nothing to point at right now — bail out gracefully without setting
        // the seen flag, so the user gets another chance on a later visit.
        setActive(false);
        return prev;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, visibleSteps]);

  // Recompute callout position when the step or window changes.
  useLayoutEffect(() => {
    if (!active) return;
    const step = visibleSteps[stepIndex];
    if (!step) return;
    const anchor = findAnchor(step.anchor);
    if (!anchor) {
      // Anchor disappeared between renders — advance.
      const advanceFrame = window.requestAnimationFrame(advance);
      return () => window.cancelAnimationFrame(advanceFrame);
    }
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const calloutHeight = calloutRef.current?.offsetHeight ?? 160;
      setPosition(computePosition(rect, step.placement, calloutHeight));
    };
    measure();
    // After the callout mounts we may have its real height; re-measure on the
    // next frame for an accurate placement.
    const raf = window.requestAnimationFrame(() => {
      measure();
      forceRender((n) => n + 1);
    });
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [active, stepIndex, visibleSteps, advance]);

  // Escape key advances the tour (matches the "Got it" affordance).
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, advance]);

  if (!active) return null;
  const step = visibleSteps[stepIndex];
  if (!step) return null;

  const total = visibleSteps.length;
  const isLast = stepIndex === total - 1;
  const pos = position;

  return (
    <div
      aria-live="polite"
      role="dialog"
      aria-label="Builder tour"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      {/* Subtle dimming backdrop. pointer-events: none so the underlying UI
          stays clickable — the tour is informational, not a modal block. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(8, 12, 16, 0.45)",
          pointerEvents: "none",
        }}
      />

      {/* Highlight ring around the current anchor. */}
      {pos && (
        <div
          style={{
            position: "absolute",
            top: pos.anchorTop - 6,
            left: pos.anchorLeft - 6,
            width: pos.anchorWidth + 12,
            height: pos.anchorHeight + 12,
            borderRadius: 10,
            border: "2px solid rgba(184, 242, 92, 0.7)",
            boxShadow: "0 0 0 4px rgba(184, 242, 92, 0.15)",
            pointerEvents: "none",
            animation: "builderTourPulse 2s ease-in-out infinite",
          }}
        />
      )}

      {/* Callout. pointer-events restored so its buttons work. */}
      <div
        ref={calloutRef}
        style={{
          position: "absolute",
          top: pos?.top ?? 80,
          left: pos?.left ?? 80,
          width: CALLOUT_WIDTH,
          pointerEvents: "auto",
          background: "var(--panel, #14181B)",
          border: "1px solid var(--green-deep, #4A6B1A)",
          borderRadius: 12,
          padding: 14,
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
          color: "var(--silver-50, #E8ECEF)",
          fontSize: 13,
          lineHeight: 1.45,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          {visibleSteps.map((_, i) => (
            <span
              key={i}
              aria-hidden
              style={{
                width: i === stepIndex ? 18 : 6,
                height: 6,
                borderRadius: 999,
                background: i === stepIndex ? "var(--green, #B8F25C)" : "rgba(255,255,255,0.18)",
                transition: "width 0.18s ease",
              }}
            />
          ))}
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 10.5,
              color: "var(--silver-400, #8B9296)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {stepIndex + 1} of {total}
          </span>
        </div>
        <div
          style={{
            fontWeight: 600,
            fontSize: 14,
            marginBottom: 4,
            color: "var(--silver-50, #E8ECEF)",
          }}
        >
          {step.title}
        </div>
        <div style={{ color: "var(--silver-300, #B5BCC1)", marginBottom: 12 }}>{step.body}</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            type="button"
            onClick={dismiss}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--silver-400, #8B9296)",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
            }}
          >
            Skip tour
          </button>
          <button
            type="button"
            onClick={advance}
            style={{
              background: "var(--green, #B8F25C)",
              color: "#0E1A02",
              border: "none",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            {isLast ? "Done" : "Got it"}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes builderTourPulse {
          0%, 100% { box-shadow: 0 0 0 4px rgba(184, 242, 92, 0.15); }
          50% { box-shadow: 0 0 0 8px rgba(184, 242, 92, 0.05); }
        }
      `}</style>
    </div>
  );
}
