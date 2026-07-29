import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { I, type IconKey } from "@/workbench/icons";
import {
  setExternalToastPush,
  ToastContext,
  type Toast,
  type ToastContextValue,
  type ToastTone,
} from "./toast-state";

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastContextValue["push"]>((input) => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const toast: Toast = {
      id,
      tone: input.tone ?? "info",
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? (input.tone === "error" ? 7000 : 4500),
    };
    setToasts((current) => [...current, toast]);
    return id;
  }, []);

  const clear = useCallback(() => setToasts([]), []);

  useEffect(() => {
    setExternalToastPush(push);
    return () => {
      setExternalToastPush(null);
    };
  }, [push]);

  const value = useMemo(() => ({ toasts, push, dismiss, clear }), [toasts, push, dismiss, clear]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="wb-root wb-root wb-root"
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        pointerEvents: "none",
        background: "transparent",
        height: "auto",
        overflow: "visible",
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = window.setTimeout(onDismiss, toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.durationMs, onDismiss]);

  const style = toneStyles(toast.tone);
  const Ico = I[style.icon] || I.alert;

  return (
    <div
      role="status"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        maxWidth: 380,
        padding: "12px 14px",
        borderRadius: 10,
        border: `1px solid ${style.border}`,
        background: "rgba(20, 24, 26, 0.95)",
        backdropFilter: "blur(8px)",
        color: "var(--silver-100)",
        fontSize: 13,
        boxShadow: "0 12px 30px -10px rgba(0,0,0,0.6)",
      }}
    >
      <Ico size={15} style={{ marginTop: 1, color: style.iconColor, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, lineHeight: 1.4, color: "var(--silver-50)" }}>
          {toast.title}
        </div>
        {toast.description && (
          <div className="muted" style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5 }}>
            {toast.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          marginRight: -2,
          marginTop: -2,
          width: 22,
          height: 22,
          borderRadius: 4,
          background: "transparent",
          border: "none",
          color: "var(--silver-400)",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
        }}
      >
        <I.close size={12} />
      </button>
    </div>
  );
}

function toneStyles(tone: ToastTone): { icon: IconKey; iconColor: string; border: string } {
  switch (tone) {
    case "success":
      return { icon: "check", iconColor: "var(--green)", border: "rgba(184,242,92,0.3)" };
    case "error":
      return { icon: "alert", iconColor: "var(--danger)", border: "rgba(242,107,92,0.3)" };
    case "warn":
      return { icon: "alert", iconColor: "var(--warn)", border: "rgba(242,196,92,0.3)" };
    case "info":
    default:
      return { icon: "bell", iconColor: "var(--silver-300)", border: "var(--line-2)" };
  }
}
