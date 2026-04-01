"use client";

interface ComplianceDownloadButtonClientProps {
  reportHtml: string;
}

export function ComplianceDownloadButtonClient({ reportHtml }: ComplianceDownloadButtonClientProps) {
  function handleDownload() {
    const blob = new Blob([reportHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eigent-compliance-report-${new Date().toISOString().split("T")[0]}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      onClick={handleDownload}
      className="bg-accent/10 border border-accent/30 rounded-lg px-4 py-2 text-xs font-display text-accent hover:bg-accent/20 hover:border-accent/50 transition-colors flex items-center gap-2"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      Generate Report
    </button>
  );
}
