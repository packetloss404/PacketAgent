/* eslint-disable react-refresh/only-export-components -- This module intentionally exports a stable registry of stateless icon components. */
import type { CSSProperties, ReactNode, SVGAttributes } from "react";

type IconProps = {
  d?: string;
  size?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  children?: ReactNode;
  viewBox?: string;
  style?: CSSProperties;
  className?: string;
} & Omit<
  SVGAttributes<SVGSVGElement>,
  "fill" | "stroke" | "strokeWidth" | "children" | "style" | "className" | "viewBox"
>;

export const Icon = ({
  d,
  size = 16,
  fill = "none",
  stroke = "currentColor",
  strokeWidth = 1.6,
  children,
  viewBox = "0 0 24 24",
  style,
  className,
  ...rest
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill={fill}
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    className={className}
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

type P = Partial<IconProps>;

export const I = {
  home: (p: P) => (
    <Icon {...p}>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </Icon>
  ),
  sparkle: (p: P) => (
    <Icon {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
    </Icon>
  ),
  bot: (p: P) => (
    <Icon {...p}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12v2M15 12v2M2 13h2M20 13h2" />
    </Icon>
  ),
  flow: (p: P) => (
    <Icon {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v3a3 3 0 003 3h6a3 3 0 003-3v-3" />
    </Icon>
  ),
  activity: (p: P) => (
    <Icon {...p}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </Icon>
  ),
  key: (p: P) => (
    <Icon {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l3 3" />
    </Icon>
  ),
  settings: (p: P) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8L4.2 6a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </Icon>
  ),
  search: (p: P) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Icon>
  ),
  plus: (p: P) => (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  arrow: (p: P) => (
    <Icon {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  ),
  arrowUp: (p: P) => (
    <Icon {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  ),
  upload: (p: P) => (
    <Icon {...p}>
      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
    </Icon>
  ),
  download: (p: P) => (
    <Icon {...p}>
      <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
    </Icon>
  ),
  chevDown: (p: P) => (
    <Icon {...p}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  ),
  chevRight: (p: P) => (
    <Icon {...p}>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  ),
  check: (p: P) => (
    <Icon {...p}>
      <path d="M5 13l4 4L19 7" />
    </Icon>
  ),
  close: (p: P) => (
    <Icon {...p}>
      <path d="M6 6l12 12M18 6l-12 12" />
    </Icon>
  ),
  alert: (p: P) => (
    <Icon {...p}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </Icon>
  ),
  database: (p: P) => (
    <Icon {...p}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </Icon>
  ),
  code: (p: P) => (
    <Icon {...p}>
      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
    </Icon>
  ),
  play: (p: P) => (
    <Icon {...p}>
      <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />
    </Icon>
  ),
  rocket: (p: P) => (
    <Icon {...p}>
      <path d="M14 4s7 1 7 7-7 7-7 7l-2-2-3-3-2-2s0-7 7-7z" />
      <path d="M9 11l-4 4M11 13l-4 4" />
      <circle cx="15" cy="9" r="1.5" />
    </Icon>
  ),
  webhook: (p: P) => (
    <Icon {...p}>
      <circle cx="6.5" cy="17" r="2.5" />
      <circle cx="17.5" cy="17" r="2.5" />
      <circle cx="12" cy="6.5" r="2.5" />
      <path d="M9 17h6M14 8.5l3 6M9.5 8.5l-3 6" />
    </Icon>
  ),
  history: (p: P) => (
    <Icon {...p}>
      <path d="M3 12a9 9 0 109-9 9 9 0 00-7 3" />
      <path d="M3 4v4h4M12 7v5l3 2" />
    </Icon>
  ),
  refresh: (p: P) => (
    <Icon {...p}>
      <path d="M3 12a9 9 0 0115-7l3 3M21 12a9 9 0 01-15 7l-3-3" />
      <path d="M21 3v6h-6M3 21v-6h6" />
    </Icon>
  ),
  layout: (p: P) => (
    <Icon {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </Icon>
  ),
  msg: (p: P) => (
    <Icon {...p}>
      <path d="M21 12a8 8 0 01-12 7l-6 2 2-6a8 8 0 1116-3z" />
    </Icon>
  ),
  doc: (p: P) => (
    <Icon {...p}>
      <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" />
      <path d="M14 3v6h6M9 13h6M9 17h6M9 9h2" />
    </Icon>
  ),
  shield: (p: P) => (
    <Icon {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  ),
  pulse: (p: P) => (
    <Icon {...p}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </Icon>
  ),
  users: (p: P) => (
    <Icon {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0112 0M16 4a3.5 3.5 0 010 7M21 20a6 6 0 00-4-5.7" />
    </Icon>
  ),
  share: (p: P) => (
    <Icon {...p}>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 11l7-3.5M8.5 13l7 3.5" />
    </Icon>
  ),
  link: (p: P) => (
    <Icon {...p}>
      <path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
      <path d="M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
    </Icon>
  ),
  copy: (p: P) => (
    <Icon {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </Icon>
  ),
  eye: (p: P) => (
    <Icon {...p}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  more: (p: P) => (
    <Icon {...p}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </Icon>
  ),
  filter: (p: P) => (
    <Icon {...p}>
      <path d="M3 5h18l-7 9v6l-4-2v-4z" />
    </Icon>
  ),
  cmd: (p: P) => (
    <Icon {...p}>
      <path d="M9 9h6v6H9z" />
      <path d="M9 9V6a3 3 0 10-3 3h3M15 9h3a3 3 0 10-3-3v3M15 15v3a3 3 0 103-3h-3M9 15H6a3 3 0 103 3v-3" />
    </Icon>
  ),
  cpu: (p: P) => (
    <Icon {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </Icon>
  ),
  zap: (p: P) => (
    <Icon {...p}>
      <path d="M13 2L3 14h7l-1 8 10-12h-7z" />
    </Icon>
  ),
  globe: (p: P) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13 13 0 010 18M12 3a13 13 0 000 18" />
    </Icon>
  ),
  lock: (p: P) => (
    <Icon {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 118 0v4" />
    </Icon>
  ),
  bell: (p: P) => (
    <Icon {...p}>
      <path d="M6 8a6 6 0 1112 0c0 7 3 7 3 9H3c0-2 3-2 3-9zM10 21a2 2 0 004 0" />
    </Icon>
  ),
  branch: (p: P) => (
    <Icon {...p}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M6 7v10M18 7v3a4 4 0 01-4 4H8" />
    </Icon>
  ),
  trash: (p: P) => (
    <Icon {...p}>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M5 6l1 14a2 2 0 002 2h8a2 2 0 002-2l1-14" />
    </Icon>
  ),
  edit: (p: P) => (
    <Icon {...p}>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" />
    </Icon>
  ),
  pause: (p: P) => (
    <Icon {...p}>
      <rect x="6" y="5" width="4" height="14" />
      <rect x="14" y="5" width="4" height="14" />
    </Icon>
  ),
  flag: (p: P) => (
    <Icon {...p}>
      <path d="M4 21V4M4 4h13l-2 4 2 4H4" />
    </Icon>
  ),
  inbox: (p: P) => (
    <Icon {...p}>
      <path d="M3 13h5l1 3h6l1-3h5" />
      <path d="M5 5h14l2 8v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6z" />
    </Icon>
  ),
  logo: (p: P) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M7 12h10M12 7v10" />
    </Icon>
  ),
  card: (p: P) => (
    <Icon {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6 15h3" />
    </Icon>
  ),
  vault: (p: P) => (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5v-1M12 16.5v-1M15.5 12h1M7.5 12h1" />
    </Icon>
  ),
  gauge: (p: P) => (
    <Icon {...p}>
      <path d="M3 14a9 9 0 0118 0" />
      <path d="M12 14l4-4" />
      <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  ),
  archive: (p: P) => (
    <Icon {...p}>
      <rect x="3" y="3" width="18" height="5" rx="1" />
      <path d="M5 8v11a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" />
    </Icon>
  ),
  github: (p: P) => (
    <Icon {...p}>
      <path
        d="M12 2a10 10 0 00-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.57 9.57 0 015 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  ),
  star: (p: P) => (
    <Icon {...p}>
      <path
        d="M12 3l2.95 6 6.55.95-4.75 4.6 1.12 6.55L12 18l-5.87 3.1 1.12-6.55-4.75-4.6L9.05 9z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  ),
  terminal: (p: P) => (
    <Icon {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h5" />
    </Icon>
  ),
};

export type IconKey = keyof typeof I;
