import { createContext, useContext } from "react";

export type ToastTone = "success" | "error" | "info" | "warn";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  durationMs: number;
}

export interface ToastContextValue {
  toasts: Toast[];
  push: (input: {
    tone?: ToastTone;
    title: string;
    description?: string;
    durationMs?: number;
  }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

let externalPush: ToastContextValue["push"] | null = null;

export function setExternalToastPush(push: ToastContextValue["push"] | null) {
  externalPush = push;
}

export function pushExternalToast(input: {
  tone?: ToastTone;
  title: string;
  description?: string;
  durationMs?: number;
}) {
  externalPush?.(input);
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used within ToastProvider");
  return value;
}
