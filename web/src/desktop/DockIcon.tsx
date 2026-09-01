import type { ComponentType, SVGProps } from "react";

type DockIconProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

export function DockIcon({ icon: Icon }: DockIconProps) {
  return (
    <span className="dock-icon" aria-hidden="true">
      <Icon />
    </span>
  );
}
