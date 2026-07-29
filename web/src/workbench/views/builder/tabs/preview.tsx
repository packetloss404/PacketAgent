import { useEffect, useRef, useState } from "react";
import { I } from "../../../icons";
import type { AppBuilderDraft } from "@/lib/types";
import { api } from "@/lib/api";
import { parsePreviewBridgeMessage } from "../helpers";
import type { SelectedElement } from "../types";
import { SharePopover } from "../share";
import { DataCard, PageCard, RouteRow } from "../cards";

export function PreviewTab({
  draft,
  appId,
  checkpointId,
  previewUrl,
  onSelectElement,
  selectedSelector,
}: {
  draft: AppBuilderDraft;
  appId: string | null;
  checkpointId: string | null;
  previewUrl: string | null;
  onSelectElement: (sel: SelectedElement) => void;
  selectedSelector: string | null;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewKey =
    appId && previewUrl ? `${appId}:${checkpointId ?? "current"}:${previewUrl}` : null;
  const [isolatedPreview, setIsolatedPreview] = useState<{
    key: string;
    url: string;
  } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const isolatedPreviewUrl =
    previewKey && isolatedPreview?.key === previewKey ? isolatedPreview.url : null;
  const previewError =
    previewKey && previewFailure?.key === previewKey ? previewFailure.message : null;
  const [hoverRect, setHoverRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!appId || !previewKey) return;
    api
      .createPreviewToken(appId, {
        scope: "interact",
        ...(checkpointId ? { checkpointId } : {}),
      })
      .then((result) => {
        if (!cancelled) setIsolatedPreview({ key: previewKey, url: result.previewUrl });
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setPreviewFailure({
            key: previewKey,
            message: error.message || "Could not open the isolated preview.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId, checkpointId, previewKey]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !isolatedPreviewUrl) return;
    const expectedOrigin = new URL(isolatedPreviewUrl).origin;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== expectedOrigin || event.source !== iframe.contentWindow) return;
      const message = parsePreviewBridgeMessage(event.data);
      if (!message) return;
      if (message.kind === "ready" || message.kind === "clear") {
        setHoverRect(null);
        return;
      }
      if (message.kind === "hover") {
        setHoverRect(message.rect);
        return;
      }
      if (message.kind !== "select") return;
      onSelectElement({
        selector: message.selector,
        label: message.label.slice(0, 60),
      });
      setHoverRect(null);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [isolatedPreviewUrl, onSelectElement]);

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
      {previewUrl && appId ? (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          {isolatedPreviewUrl ? (
            <iframe
              ref={iframeRef}
              src={isolatedPreviewUrl}
              title={`${draft.app.name} generated app preview`}
              sandbox="allow-forms allow-modals allow-same-origin allow-scripts"
              referrerPolicy="no-referrer"
              style={{
                width: "100%",
                height: "100%",
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: "var(--ink)",
              }}
            />
          ) : (
            <div
              className="card"
              style={{ height: "100%", display: "grid", placeItems: "center", padding: 24 }}
            >
              <span className="muted">{previewError ?? "Opening the isolated preview…"}</span>
            </div>
          )}
          {isolatedPreviewUrl && hoverRect && (
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
