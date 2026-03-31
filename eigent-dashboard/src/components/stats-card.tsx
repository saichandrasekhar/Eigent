interface StatsCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  trend?: { value: number; direction: "up" | "down" };
  variant?: "default" | "danger" | "warning" | "accent";
}

const variantStyles = {
  default: "border-border",
  danger: "border-severity-critical/30",
  warning: "border-severity-medium/30",
  accent: "border-accent/30",
};

const variantGlows = {
  default: "",
  danger: "shadow-[0_0_30px_-10px_rgba(239,68,68,0.15)]",
  warning: "shadow-[0_0_30px_-10px_rgba(234,179,8,0.15)]",
  accent: "shadow-[0_0_30px_-10px_rgba(124,106,239,0.15)]",
};

export function StatsCard({ label, value, icon, trend, variant = "default" }: StatsCardProps) {
  return (
    <div
      className={`
        bg-bg-card rounded-xl border ${variantStyles[variant]} ${variantGlows[variant]}
        p-5 transition-all duration-200 hover:border-border-light
      `}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-text-muted text-xs font-display uppercase tracking-wider">
          {label}
        </span>
        <span className="text-text-muted">{icon}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-3xl font-bold font-mono text-text-primary">{value}</span>
        {trend && (
          <span
            className={`text-xs font-mono mb-1 ${
              trend.direction === "up" ? "text-severity-critical" : "text-status-pass"
            }`}
          >
            {trend.direction === "up" ? "\u2191" : "\u2193"} {trend.value}%
          </span>
        )}
      </div>
    </div>
  );
}
