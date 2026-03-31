interface RiskBadgeProps {
  level: string;
  size?: "sm" | "md";
}

const colors: Record<string, { bg: string; text: string; dot: string }> = {
  critical: {
    bg: "bg-severity-critical/10",
    text: "text-severity-critical",
    dot: "bg-severity-critical",
  },
  high: {
    bg: "bg-severity-high/10",
    text: "text-severity-high",
    dot: "bg-severity-high",
  },
  medium: {
    bg: "bg-severity-medium/10",
    text: "text-severity-medium",
    dot: "bg-severity-medium",
  },
  low: {
    bg: "bg-severity-low/10",
    text: "text-severity-low",
    dot: "bg-severity-low",
  },
  info: {
    bg: "bg-severity-info/10",
    text: "text-severity-info",
    dot: "bg-severity-info",
  },
  clean: {
    bg: "bg-status-pass/10",
    text: "text-status-pass",
    dot: "bg-status-pass",
  },
  none: {
    bg: "bg-severity-critical/10",
    text: "text-severity-critical",
    dot: "bg-severity-critical",
  },
  unknown: {
    bg: "bg-severity-info/10",
    text: "text-severity-info",
    dot: "bg-severity-info",
  },
};

export function RiskBadge({ level, size = "sm" }: RiskBadgeProps) {
  const style = colors[level.toLowerCase()] || colors.unknown;
  const padding = size === "sm" ? "px-2 py-0.5" : "px-3 py-1";
  const textSize = size === "sm" ? "text-[0.65rem]" : "text-xs";

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full font-mono
        ${style.bg} ${style.text} ${padding} ${textSize}
      `}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {level.toUpperCase()}
    </span>
  );
}
