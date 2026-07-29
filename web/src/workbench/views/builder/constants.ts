import type { BuilderModelPresetId } from "@/lib/types";

export const PRESET_OPTIONS: Array<{
  id: BuilderModelPresetId;
  label: string;
  hint: string;
  friendly: string;
}> = [
  {
    id: "fast",
    label: "Lightning",
    hint: "Low latency",
    friendly: "Fast and cheap. Best for simple drafts and quick iteration",
  },
  {
    id: "smart",
    label: "Pro",
    hint: "Best quality",
    friendly: "Best quality. Uses the most capable model your provider offers",
  },
  {
    id: "cheap",
    label: "Cheap",
    hint: "Cost-aware",
    friendly: "Lowest cost. Good for very small changes",
  },
  {
    id: "local",
    label: "Local",
    hint: "Ollama-first",
    friendly: "Use your own local LLM (Ollama, vLLM, or LM Studio)",
  },
];

/**
 * Quality-tier ladder used by the per-message "Try again smarter" affordance.
 * `local` is a separate provider axis and not part of the smarter ladder; when
 * the user is on `local` we treat them as already at the top tier (the button
 * surfaces the "Already at the highest preset." tooltip).
 */
export const SMARTER_TIER_LADDER: BuilderModelPresetId[] = ["cheap", "fast", "smart"];
