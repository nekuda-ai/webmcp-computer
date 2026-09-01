import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  width: 22,
  height: 22,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function FilesIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4l2 2h5.5A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2 14.5z" />
    </svg>
  );
}

export function EditorIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m13.5 3.5 3 3-9 9-3.8.8.8-3.8z" />
      <path d="m11.5 5.5 3 3" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="m5.5 7 3 3-3 3M10.5 13h3.5" />
    </svg>
  );
}

export function NotesIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M4 3.5h12v10l-3 3H4z" />
      <path d="M13 16.5v-3h3M7 7h6M7 10h5" />
    </svg>
  );
}

export function PreviewIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="2.5" y="3.5" width="15" height="11" rx="1.5" />
      <path d="M7 17h6M10 14.5V17" />
      <path d="m8.5 7 4 2-4 2z" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M8.8 2.8h2.4l.5 2a6 6 0 0 1 1.1.6l2-.6L16 6.9l-1.5 1.4a6 6 0 0 1 0 1.3L16 11l-1.2 2.1-2-.6a6 6 0 0 1-1.1.6l-.5 2H8.8l-.5-2a6 6 0 0 1-1.1-.6l-2 .6L4 11l1.5-1.4a6 6 0 0 1 0-1.3L4 6.9l1.2-2.1 2 .6a6 6 0 0 1 1.1-.6z" />
    </svg>
  );
}

export function BrowserIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M2.75 10h14.5M10 2.75c2 2 3 4.4 3 7.25s-1 5.25-3 7.25M10 2.75C8 4.75 7 7.15 7 10s1 5.25 3 7.25" />
    </svg>
  );
}

export function UiIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 7h15M10 9v5M7.8 10.2l4.4 2.6M12.2 10.2l-4.4 2.6" />
    </svg>
  );
}
