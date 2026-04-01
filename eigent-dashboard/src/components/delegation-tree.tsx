"use client";

import { useState } from "react";

interface TreeNode {
  id: string;
  name: string;
  human_email: string;
  scope: string[];
  status: string;
  delegation_depth: number;
  created_at: string;
  expires_at?: string;
  parent_id: string | null;
  children: TreeNode[];
}

interface DelegationTreeProps {
  agents: TreeNode[];
  onNodeClick?: (agentId: string) => void;
  compact?: boolean;
}

const statusColors: Record<string, { border: string; bg: string; dot: string; text: string }> = {
  active: {
    border: "border-status-pass/40",
    bg: "bg-status-pass/5",
    dot: "bg-status-pass",
    text: "text-status-pass",
  },
  revoked: {
    border: "border-status-fail/40",
    bg: "bg-status-fail/5",
    dot: "bg-status-fail",
    text: "text-status-fail",
  },
  expired: {
    border: "border-status-partial/40",
    bg: "bg-status-partial/5",
    dot: "bg-status-partial",
    text: "text-status-partial",
  },
};

function getEffectiveStatus(node: TreeNode): string {
  if (node.status === "revoked") return "revoked";
  if (node.expires_at && new Date(node.expires_at) < new Date()) return "expired";
  return "active";
}

function TreeNodeCard({
  node,
  onNodeClick,
  isRoot,
  isLast,
  compact,
}: {
  node: TreeNode;
  onNodeClick?: (id: string) => void;
  isRoot: boolean;
  isLast: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const effectiveStatus = getEffectiveStatus(node);
  const colors = statusColors[effectiveStatus] ?? statusColors.active;
  const hasChildren = node.children.length > 0;

  return (
    <div className="relative">
      {/* Connector lines */}
      {!isRoot && (
        <div className="absolute left-[-24px] top-0 bottom-0">
          {/* Horizontal connector */}
          <div className="absolute top-[22px] left-0 w-[24px] h-[1px] bg-border-light" />
          {/* Vertical connector continuing down for siblings */}
          {!isLast && (
            <div className="absolute top-0 left-0 w-[1px] h-full bg-border-light" />
          )}
          {/* Vertical connector to this node */}
          <div className="absolute top-0 left-0 w-[1px] h-[23px] bg-border-light" />
        </div>
      )}

      {/* Node card */}
      <div
        className={`
          relative rounded-lg border ${colors.border} ${colors.bg}
          ${compact ? "px-3 py-2" : "px-4 py-3"}
          cursor-pointer hover:border-accent/40 transition-all duration-200
          group
        `}
        onClick={() => onNodeClick?.(node.id)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {/* Human or Agent icon */}
              {node.delegation_depth === 0 ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-light shrink-0">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="12" cy="10" r="3" />
                  <path d="M7 21v-1a5 5 0 0110 0v1" />
                </svg>
              )}
              <span className="font-display font-semibold text-text-primary text-sm truncate">
                {node.name}
              </span>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[0.6rem] font-mono ${colors.bg} ${colors.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                {effectiveStatus.toUpperCase()}
              </span>
            </div>

            {/* Human binding */}
            <div className="text-text-muted text-[0.65rem] font-mono truncate mb-1.5">
              {node.human_email}
            </div>

            {/* Scope tags */}
            <div className="flex flex-wrap gap-1">
              {node.scope.slice(0, compact ? 3 : 6).map((s) => (
                <span
                  key={s}
                  className="inline-block bg-accent/10 text-accent text-[0.6rem] font-mono px-1.5 py-0.5 rounded"
                >
                  {s}
                </span>
              ))}
              {node.scope.length > (compact ? 3 : 6) && (
                <span className="text-text-muted text-[0.6rem] font-mono">
                  +{node.scope.length - (compact ? 3 : 6)} more
                </span>
              )}
            </div>
          </div>

          {/* Expand/collapse for children */}
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              className="text-text-muted hover:text-text-secondary transition-colors p-1 shrink-0"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>

        {/* Depth indicator */}
        {node.delegation_depth > 0 && (
          <div className="absolute -left-1 top-3 w-2 h-2 rounded-full bg-accent/30 border border-accent/50" />
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="ml-8 mt-2 space-y-2 relative">
          {/* Vertical line connecting children */}
          <div className="absolute left-[-24px] top-0 bottom-0 w-[1px] bg-border-light" />
          {node.children.map((child, i) => (
            <TreeNodeCard
              key={child.id}
              node={child}
              onNodeClick={onNodeClick}
              isRoot={false}
              isLast={i === node.children.length - 1}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function buildTree(agents: Omit<TreeNode, "children">[]): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  // Create nodes
  for (const agent of agents) {
    nodeMap.set(agent.id, { ...agent, children: [] });
  }

  // Link children
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function DelegationTree({ agents, onNodeClick, compact }: DelegationTreeProps) {
  if (agents.length === 0) {
    return (
      <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted mx-auto mb-3">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <p className="text-text-muted text-sm font-display">No delegation chains found.</p>
        <p className="text-text-muted text-xs font-mono mt-1">Register agents in the registry to see delegation trees.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {agents.map((root) => (
        <TreeNodeCard
          key={root.id}
          node={root}
          onNodeClick={onNodeClick}
          isRoot={true}
          isLast={true}
          compact={compact}
        />
      ))}
    </div>
  );
}
