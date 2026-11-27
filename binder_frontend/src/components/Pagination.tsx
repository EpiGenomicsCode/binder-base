import { useEffect, useState } from "react";

/**
 * The table footer shared by every paged list: page size, a readout of which
 * rows are on screen, and navigation.
 *
 * It replaces three byte-identical copies of a Prev/Next pair (ProteinList,
 * RunList, BindersTable). Prev/Next alone is fine for three pages and useless
 * for ninety: reaching page 60 of a 2,900-target catalogue meant clicking Next
 * fifty-nine times, or raising the page size until the browser struggled. So
 * this adds numbered pages, first/last, and a jump box.
 */

/** Pages shown either side of the current one before collapsing to an ellipsis. */
const WINDOW = 2;

/** Below this, every page gets a button and the jump box is noise. */
const COMPACT_MAX = 7;

type Item = number | "gap";

/** 1 … 7 8 [9] 10 11 … 42 — first and last are always reachable. */
export function pageItems(page: number, total: number): Item[] {
  if (total <= COMPACT_MAX) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items: Item[] = [1];
  const lo = Math.max(2, page - WINDOW);
  const hi = Math.min(total - 1, page + WINDOW);
  if (lo > 2) items.push("gap");
  for (let p = lo; p <= hi; p++) items.push(p);
  if (hi < total - 1) items.push("gap");
  items.push(total);
  return items;
}

type Props = {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  pageSize: number;
  pageSizes: readonly number[];
  onPageSize: (size: number) => void;
  /** Rows after filtering — the denominator in "x–y of z". */
  total: number;
  /** What a row is, for the readout: "targets", "runs", "designs". */
  noun: string;
  /**
   * Scrolled back into view when the page changes. Without it, clicking Next
   * from the bottom of a 100-row table leaves you at the bottom of the next
   * one, reading row 100 of a page you have not seen the top of.
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
};

export default function Pagination({
  page,
  totalPages,
  onPage,
  pageSize,
  pageSizes,
  onPageSize,
  total,
  noun,
  anchorRef,
}: Props) {
  const [jump, setJump] = useState("");

  // The parent clamps `page` when a filter shrinks the list, so the box must
  // not keep showing a page number that no longer exists.
  useEffect(() => setJump(""), [page, totalPages]);

  const go = (next: number) => {
    const clamped = Math.min(Math.max(1, next), totalPages);
    if (clamped === page) return;
    onPage(clamped);
    anchorRef?.current?.scrollIntoView({ block: "start" });
  };

  const submitJump = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = Number(jump);
    if (Number.isFinite(parsed) && parsed >= 1) go(Math.floor(parsed));
    setJump("");
  };

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="binder-pagination">
      <div className="binder-page-size-group">
        <span className="binder-page-size-label">Show:</span>
        {pageSizes.map((size) => (
          <button
            key={size}
            className={`binder-page-size-btn${pageSize === size ? " active" : ""}`}
            onClick={() => onPageSize(size)}
            aria-pressed={pageSize === size}
          >
            {size}
          </button>
        ))}
        <span className="binder-page-range">
          {total === 0
            ? `no ${noun}`
            : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
        </span>
      </div>

      {totalPages > 1 && (
        <nav className="binder-page-nav" aria-label={`${noun} pagination`}>
          <button
            className="binder-page-btn"
            onClick={() => go(1)}
            disabled={page === 1}
            aria-label="First page"
          >
            ««
          </button>
          <button
            className="binder-page-btn"
            onClick={() => go(page - 1)}
            disabled={page === 1}
          >
            ← Prev
          </button>

          <span className="binder-page-numbers">
            {pageItems(page, totalPages).map((item, i) =>
              item === "gap" ? (
                <span className="binder-page-ellipsis" key={`gap-${i}`}>
                  …
                </span>
              ) : (
                <button
                  key={item}
                  className={`binder-page-num${item === page ? " active" : ""}`}
                  onClick={() => go(item)}
                  aria-current={item === page ? "page" : undefined}
                  aria-label={`Page ${item}`}
                >
                  {item}
                </button>
              )
            )}
          </span>

          <button
            className="binder-page-btn"
            onClick={() => go(page + 1)}
            disabled={page === totalPages}
          >
            Next →
          </button>
          <button
            className="binder-page-btn"
            onClick={() => go(totalPages)}
            disabled={page === totalPages}
            aria-label="Last page"
          >
            »»
          </button>

          {totalPages > COMPACT_MAX && (
            <form className="binder-page-jump" onSubmit={submitJump}>
              <label htmlFor={`jump-${noun}`}>Go to</label>
              <input
                id={`jump-${noun}`}
                type="number"
                min={1}
                max={totalPages}
                value={jump}
                placeholder={String(page)}
                onChange={(e) => setJump(e.target.value)}
                aria-label={`Go to page, 1 to ${totalPages}`}
              />
              <button type="submit" className="binder-page-btn" disabled={!jump}>
                Go
              </button>
            </form>
          )}
        </nav>
      )}
    </div>
  );
}
