"use client";

import { useState } from "react";
import { DelegationTree, buildTree } from "@/components/delegation-tree";

interface AgentNode {
  id: string;
  name: string;
  human_email: string;
  scope: string[];
  status: string;
  delegation_depth: number;
  max_delegation_depth: number;
  created_at: string;
  expires_at: string;
  parent_id: string | null;
  can_delegate: string[] | null;
}

interface DelegationExplorerProps {
  agents: AgentNode[];
}

export function DelegationExplorer({ agents }: DelegationExplorerProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [humanFilter, setHumanFilter] = useState("all");

  const uniqueHumans = ["all", ...new Set(agents.map((a) => a.human_email))];

  let filtered = agents;
  if (statusFilter !== "all") {
    filtered = filtered.filter((a) => a.status === statusFilter);
  }
  if (humanFilter !== "all") {
    filtered = filtered.filter((a) => a.human_email === humanFilter);
  }

  // Build tree from filtered agents
  const treeNodes = filtered.map((a) => ({
    id: a.id,
    name: a.name,
    human_email: a.human_email,
    scope: a.scope,
    status: a.status,
    delegation_depth: a.delegation_depth,
    created_at: a.created_at,
    expires_at: a.expires_at,
    parent_id: a.parent_id,
  }));
  const tree = buildTree(treeNodes);

  // Find selected agent details
  const selectedAgent = selectedNode ? agents.find((a) => a.id === selectedNode) : null;

  // Build scope narrowing view for selected agent
  function getScopeChain(agentId: string): Array<{ name: string; scope: string[]; depth: number }> {
    const chain: Array<{ name: string; scope: string[]; depth: number }> = [];
    let current = agents.find((a) => a.id === agentId);
    while (current) {
      chain.unshift({ name: current.name, scope: current.scope, depth: current.delegation_depth });
      if (current.parent_id) {
        current = agents.find((a) => a.id === current!.parent_id);
      } else {
        break;
      }
    }
    return chain;
  }

  const scopeChain = selectedNode ? getScopeChain(selectedNode) : [];

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
        </select>
        <select
          value={humanFilter}
          onChange={(e) => setHumanFilter(e.target.value)}
          className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-text-secondary focus:border-accent focus:outline-none"
        >
          {uniqueHumans.map((h) => (
            <option key={h} value={h}>
              {h === "all" ? "All Humans" : h}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tree view (2/3 width) */}
        <div className="lg:col-span-2">
          <div className="bg-bg-card rounded-xl border border-border p-6">
            <h3 className="font-display font-semibold text-sm text-text-primary mb-4">Delegation Trees</h3>
            <DelegationTree
              agents={tree}
              onNodeClick={(id) => setSelectedNode(id === selectedNode ? null : id)}
            />
          </div>
        </div>

        {/* Detail panel (1/3 width) */}
        <div>
          {selectedAgent ? (
            <div className="bg-bg-card rounded-xl border border-accent/30 p-5 space-y-5 sticky top-20">
              <div>
                <h3 className="font-display font-bold text-text-primary text-sm">{selectedAgent.name}</h3>
                <p className="text-text-muted text-[0.65rem] font-mono mt-0.5">{selectedAgent.id}</p>
              </div>

              {/* Info grid */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-bg-hover rounded-lg px-3 py-2">
                  <p className="text-text-muted text-[0.55rem] uppercase tracking-wider">Status</p>
                  <p className={`text-xs font-mono ${selectedAgent.status === "active" ? "text-status-pass" : "text-status-fail"}`}>
                    {selectedAgent.status}
                  </p>
                </div>
                <div className="bg-bg-hover rounded-lg px-3 py-2">
                  <p className="text-text-muted text-[0.55rem] uppercase tracking-wider">Depth</p>
                  <p className="text-xs font-mono text-text-primary">{selectedAgent.delegation_depth}/{selectedAgent.max_delegation_depth}</p>
                </div>
                <div className="bg-bg-hover rounded-lg px-3 py-2 col-span-2">
                  <p className="text-text-muted text-[0.55rem] uppercase tracking-wider">Human</p>
                  <p className="text-xs font-mono text-text-primary truncate">{selectedAgent.human_email}</p>
                </div>
              </div>

              {/* Scope */}
              <div>
                <p className="text-text-muted text-[0.6rem] uppercase tracking-wider mb-1.5">Scope</p>
                <div className="flex flex-wrap gap-1">
                  {selectedAgent.scope.map((s) => (
                    <span key={s} className="bg-accent/10 text-accent text-[0.6rem] font-mono px-1.5 py-0.5 rounded">
                      {s}
                    </span>
                  ))}
                </div>
              </div>

              {/* Scope Narrowing Visualization */}
              {scopeChain.length > 1 && (
                <div>
                  <p className="text-text-muted text-[0.6rem] uppercase tracking-wider mb-2">Permission Narrowing</p>
                  <div className="space-y-1.5">
                    {scopeChain.map((node, i) => {
                      const widthPct = Math.max(30, 100 - i * 20);
                      return (
                        <div key={node.name}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-text-secondary text-[0.6rem] font-mono w-16 shrink-0 truncate">{node.name}</span>
                            <span className="text-text-muted text-[0.5rem] font-mono">d{node.depth}</span>
                          </div>
                          <div className="h-3 bg-bg-hover rounded overflow-hidden">
                            <div
                              className="h-full bg-accent/30 rounded flex items-center px-1.5 transition-all duration-300"
                              style={{ width: `${widthPct}%` }}
                            >
                              <span className="text-[0.5rem] font-mono text-accent truncate">
                                {node.scope.join(", ")}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Can Delegate */}
              {selectedAgent.can_delegate && selectedAgent.can_delegate.length > 0 && (
                <div>
                  <p className="text-text-muted text-[0.6rem] uppercase tracking-wider mb-1.5">Can Delegate</p>
                  <div className="flex flex-wrap gap-1">
                    {selectedAgent.can_delegate.map((s) => (
                      <span key={s} className="bg-accent-dim/20 text-accent-light text-[0.6rem] font-mono px-1.5 py-0.5 rounded">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-bg-card rounded-xl border border-border p-8 text-center sticky top-20">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-muted mx-auto mb-2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-text-muted text-xs font-display">Click a node in the tree to see details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
