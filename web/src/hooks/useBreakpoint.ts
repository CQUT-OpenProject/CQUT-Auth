import { Grid } from "antd";

/**
 * Breakpoint state interface
 */
export interface BreakpointState {
  /** True if viewport is < 768px (xs or sm) */
  isMobile: boolean;
  /** True if viewport is 768-991px (md) */
  isTablet: boolean;
  /** True if viewport is >= 992px (lg+) */
  isDesktop: boolean;

  /** True if viewport is 0-575px */
  xs: boolean;
  /** True if viewport is 576-767px */
  sm: boolean;
  /** True if viewport is 768-991px */
  md: boolean;
  /** True if viewport is 992-1199px */
  lg: boolean;
  /** True if viewport is 1200-1599px */
  xl: boolean;
  /** True if viewport is >= 1600px */
  xxl: boolean;

  /** Current active breakpoint */
  current: "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
}

/**
 * Hook to get current responsive breakpoint state
 *
 * @returns BreakpointState object with boolean flags and current breakpoint
 *
 * @example
 * const { isMobile, isTablet, isDesktop, current } = useBreakpoint();
 *
 * // Use semantic flags
 * if (isMobile) {
 *   return <MobileLayout />;
 * }
 *
 * // Use specific breakpoints
 * if (xs || sm) {
 *   return <CompactView />;
 * }
 *
 * // Switch on current breakpoint
 * switch (current) {
 *   case 'xs': return <TinyView />;
 *   case 'sm': return <SmallView />;
 *   default: return <NormalView />;
 * }
 *
 * Uses Ant Design's shared responsive observer, so component instances reuse
 * the same breakpoint subscriptions.
 */
export function useBreakpoint(): BreakpointState {
  const screens = Grid.useBreakpoint();
  const hasActiveBreakpoint = Object.values(screens).some(Boolean);
  const xxl = Boolean(screens.xxl);
  const xl = Boolean(screens.xl) && !xxl;
  const lg = hasActiveBreakpoint ? Boolean(screens.lg) && !screens.xl : true;
  const md = Boolean(screens.md) && !screens.lg;
  const sm = Boolean(screens.sm) && !screens.md;
  const xs = Boolean(screens.xs);

  let current: BreakpointState["current"] = "lg";
  if (xs) current = "xs";
  else if (sm) current = "sm";
  else if (md) current = "md";
  else if (xl) current = "xl";
  else if (xxl) current = "xxl";

  const isMobile = xs || sm;
  const isTablet = md;
  const isDesktop = lg || xl || xxl;

  return {
    isMobile,
    isTablet,
    isDesktop,
    xs,
    sm,
    md,
    lg,
    xl,
    xxl,
    current,
  };
}
