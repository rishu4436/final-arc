"use client";

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ExportCsvButton({ csv, disabled }: { csv: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="text-sm underline disabled:opacity-40"
      disabled={disabled}
      onClick={() => downloadCsv("final-requests.csv", csv)}
    >
      Export CSV
    </button>
  );
}
