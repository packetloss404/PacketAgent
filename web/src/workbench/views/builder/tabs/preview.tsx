import { useEffect, useRef, useState } from "react";
import { I } from "../../../icons";
import type { AppBuilderDraft } from "@/lib/types";
import { cssPathFor } from "../helpers";
import type { SelectedElement } from "../types";
import { SharePopover } from "../share";
import { DataCard, PageCard, RouteRow } from "../cards";

export function PreviewTab({
  draft,
  appId,
  previewUrl,
  onSelectElement,
  selectedSelector,
}: {
  draft: AppBuilderDraft;
  appId: string | null;
  previewUrl: string | null;
  onSelectElement: (sel: SelectedElement) => void;
  selectedSelector: string | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Always-on click-to-edit (2026 norm — matches Lovable/v0/Cursor/Bolt). Hover
  // outline is gated on Cmd/Ctrl to avoid visual noise during ordinary browsing,
  // but the click-capture stays armed so users discover the affordance by trying it.
  const [hoverRect, setHoverRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [outlineArmed, setOutlineArmed] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) setOutlineArmed(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        setOutlineArmed(false);
        setHoverRect(null);
      }
    };
    const onBlur = () => {
      setOutlineArmed(false);
      setHoverRect(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const attach = () => {
      let doc: Document | null = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        doc = null;
      }
      if (!doc) return;

      const onMove = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target || target === doc!.documentElement || target === doc!.body) {
          setHoverRect(null);
          return;
        }
        const rect = target.getBoundingClientRect();
        setHoverRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      };
      const onLeave = () => setHoverRect(null);
      const onClick = (event: MouseEvent) => {
        // Only capture the click for element-select when a modifier is held.
        // Without this gate the preview's own buttons, links, inputs, and form
        // submits are all inert — the user can't actually try their app.
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        event.stopPropagation();
        const target = event.target as HTMLElement | null;
        if (!target) return;
        onSelectElement({
          selector: cssPathFor(target),
          label: (target.textContent ?? "").trim().slice(0, 60),
        });
        setHoverRect(null);
      };
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseleave", onLeave);
      doc.addEventListener("click", onClick, true);
      return () => {
        doc!.removeEventListener("mousemove", onMove);
        doc!.removeEventListener("mouseleave", onLeave);
        doc!.removeEventListener("click", onClick, true);
      };
    };

    let cleanup = attach();
    const onLoad = () => {
      if (cleanup) cleanup();
      cleanup = attach();
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      if (cleanup) cleanup();
    };
  }, [previewUrl, onSelectElement]);

  return (
    <div style={{ padding: 20, height: "100%", position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: 28,
          right: 28,
          zIndex: 10,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <SharePopover appId={appId} />
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            padding: "4px 10px",
            background: "var(--panel)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--silver-400)",
          }}
        >
          <I.zap size={11} style={{ color: "var(--green)" }} />
          <span>Hold ⌘/Ctrl and click an element to scope your next change</span>
          {selectedSelector && (
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--silver-200)",
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textTransform: "none",
                letterSpacing: 0,
              }}
            >
              · {selectedSelector}
            </span>
          )}
        </div>
      </div>
      {previewUrl ? (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <iframe
            ref={iframeRef}
            src={
              appId ? `/api/app/generated-apps/${encodeURIComponent(appId)}/preview/` : previewUrl
            }
            title={`${draft.app.name} generated app preview`}
            sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid var(--line)",
              borderRadius: 8,
              background: "var(--ink)",
            }}
          />
          {outlineArmed && hoverRect && (
            <div
              style={{
                position: "absolute",
                left: hoverRect.left,
                top: hoverRect.top,
                width: hoverRect.width,
                height: hoverRect.height,
                border: "1px solid var(--green-deep)",
                background: "rgba(184,242,92,0.06)",
                borderRadius: 2,
                pointerEvents: "none",
                boxSizing: "border-box",
              }}
            />
          )}
        </div>
      ) : (
        <div className="card grid-bg" style={{ height: "100%", overflow: "hidden", padding: 24 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Preview · not yet live
          </div>
          <h2 className="h2" style={{ fontSize: 22, marginBottom: 6 }}>
            {draft.app.name}
          </h2>
          <p className="muted" style={{ fontSize: 13, maxWidth: 640, marginBottom: 20 }}>
            {draft.app.description}
          </p>

          <div className="kicker" style={{ marginBottom: 8 }}>
            Pages · {draft.app.pages.length}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {draft.app.pages.map((p, i) => (
              <PageCard key={i} page={p} />
            ))}
          </div>

          <div className="kicker" style={{ marginBottom: 8 }}>
            API routes · {draft.app.apiRoutes.length}
          </div>
          <div className="card" style={{ overflow: "hidden", marginBottom: 20 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Access</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                {draft.app.apiRoutes.map((r, i) => (
                  <RouteRow key={i} route={r} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="kicker" style={{ marginBottom: 8 }}>
            Data · {draft.app.dataSchema.length} entit
            {draft.app.dataSchema.length === 1 ? "y" : "ies"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
            {draft.app.dataSchema.map((e, i) => (
              <DataCard key={i} entity={e} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
