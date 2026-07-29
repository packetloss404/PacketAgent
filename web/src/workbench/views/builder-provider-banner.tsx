import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { BuilderProviderStatusPayload } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: BuilderProviderStatusPayload }
  | { kind: "error" };

/**
 * Renders a friendly warning banner above the builder composer when no AI
 * provider is configured. Without a key the Builder silently falls back to the
 * 5-template generator, which is confusing for non-technical users. This
 * surfaces the situation before they invest time describing a build.
 *
 * Rendering rules:
 * - While loading: render nothing (avoid a banner that flashes then vanishes).
 * - On error: render nothing (don't block the UI on a status check).
 * - If at least one provider is available: render nothing.
 * - Otherwise: render the amber "No AI provider configured" banner.
 */
export function ProviderBanner() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .getBuilderProviderStatus()
      .then((status) => {
        if (cancelled) return;
        setState({ kind: "ready", status });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind !== "ready") return null;
  if (state.status.availableProviders.length > 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto mb-4 w-full max-w-[720px] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-base leading-none">
          ⚠
        </span>
        <div className="flex-1">
          <div className="text-sm font-medium">No AI provider configured</div>
          <p className="mt-1 text-sm text-amber-800/90">
            PacketAgent needs at least one provider to generate real apps. Without a key, you'll get
            a basic template instead of an AI-generated result.
          </p>
          <a
            href="/admin/integrations"
            className="mt-2 inline-block text-sm font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950"
          >
            Set up a key
          </a>
        </div>
      </div>
    </div>
  );
}
