import { createContext, useContext } from "react";

export interface CommandPaletteContextValue {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

export const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette() {
  const value = useContext(CommandPaletteContext);
  if (!value) {
    throw new Error("useCommandPalette must be used within CommandPaletteProvider");
  }
  return value;
}
