import type { KeyboardEvent, ReactNode } from "react";
import { isTabNavigationKey, nextTabIndex } from "./tab-navigation";

export interface AccessibleTabDefinition<TId extends string> {
  readonly id: TId;
  readonly label: ReactNode;
  readonly title?: string;
  readonly dataTour?: string;
}

export function AccessibleTabs<TId extends string>({
  id,
  label,
  tabs,
  activeId,
  onSelect,
  className = "tabbar",
}: {
  readonly id: string;
  readonly label: string;
  readonly tabs: readonly AccessibleTabDefinition<TId>[];
  readonly activeId: TId;
  readonly onSelect: (id: TId) => void;
  readonly className?: string;
}) {
  const activateFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!isTabNavigationKey(event.key)) return;
    event.preventDefault();
    const nextIndex = nextTabIndex(index, tabs.length, event.key);
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onSelect(nextTab.id);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className={className} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        return (
          <button
            type="button"
            key={tab.id}
            id={`${id}-tab-${tab.id}`}
            role="tab"
            aria-selected={selected}
            aria-controls={`${id}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            data-tour={tab.dataTour}
            className={`tab ${selected ? "active" : ""}`}
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => activateFromKeyboard(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function AccessibleTabPanel({
  id,
  tabId,
  children,
  className,
}: {
  readonly id: string;
  readonly tabId: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      id={`${id}-panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`${id}-tab-${tabId}`}
      className={className}
    >
      {children}
    </div>
  );
}
