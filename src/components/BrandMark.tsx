export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 no-underline ${className}`}>
      <img src="/logo.svg" alt="" width={32} height={32} className="h-8 w-8 rounded-sm" />
      <span className="display text-xl tracking-tight text-[var(--ink)]">Final</span>
    </span>
  );
}
