import { useEffect, useRef, useState } from "react";

/**
 * A download menu over plain links.
 *
 * Every item is an `<a download>` pointing at an export endpoint rather than a
 * fetch-then-Blob: the browser streams the response straight to disk, so a run
 * of several thousand designs never has to fit in a tab's memory, and a slow
 * download shows real progress instead of a frozen button. It also means the
 * links are copyable and scriptable -- the same URL works from curl, which is
 * the point of publishing an export at all.
 */

export interface ExportItem {
  href: string;
  label: string;
  /** One line under the label: what the file actually contains. */
  hint?: string;
}

export default function ExportMenu({
  items,
  label = "Export",
  disabled = false,
}: {
  items: ExportItem[];
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button
        className="export-menu-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
      >
        ↓ {label} ▾
      </button>
      {open && (
        <div className="export-menu-popover" role="menu">
          {items.map((it) => (
            <a
              key={it.href + it.label}
              className="export-menu-item"
              href={it.href}
              download
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <span className="export-menu-label">{it.label}</span>
              {it.hint && <span className="export-menu-hint">{it.hint}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
