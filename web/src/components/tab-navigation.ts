export type TabNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function nextTabIndex(
  currentIndex: number,
  tabCount: number,
  key: TabNavigationKey,
): number {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowLeft") return (currentIndex - 1 + tabCount) % tabCount;
  return (currentIndex + 1) % tabCount;
}

export function isTabNavigationKey(value: string): value is TabNavigationKey {
  return value === "ArrowLeft" || value === "ArrowRight" || value === "Home" || value === "End";
}
