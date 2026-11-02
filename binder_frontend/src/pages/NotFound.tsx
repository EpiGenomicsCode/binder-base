import { Link, useLocation } from "react-router-dom";
import usePageMeta from "../utils/pageMeta";

/**
 * Anything that matched no route.
 *
 * Until this existed there was no `path="*"`, so React Router matched nothing
 * and rendered nothing: a mistyped or stale URL produced the navbar, an empty
 * page and the footer, with nothing anywhere saying what had happened. A
 * deleted run, a truncated link out of an email and a plain typo all looked
 * like the site was broken.
 *
 * It cannot answer with a 404. nginx serves the SPA shell for every unknown
 * path, so these arrive with a 200 and would be indexed as real pages -- the
 * robots meta is the only part of that response this side can still set.
 */

/**
 * Near misses worth offering a link for, rather than only an apology.
 *
 * Singular for plural is the usual slip. /targets is one this app sets for
 * itself: the navbar calls the page "Targets" while the route is /proteins,
 * so anyone typing the URL from the label they were shown lands here.
 */
const ALIASES: [RegExp, string][] = [
  [/^\/(?:protein|target|targets)(?=\/|$)/i, "/proteins"],
  [/^\/run(?=\/|$)/i, "/runs"],
  [/^\/(?:structure_prep|structureprep|prep)(?=\/|$)/i, "/structure-prep"],
];

/** `/run/243` -> `/runs/243`, `/targets` -> `/proteins`, otherwise null. */
export function suggestPath(pathname: string): string | null {
  for (const [pattern, replacement] of ALIASES) {
    if (pattern.test(pathname)) return pathname.replace(pattern, replacement);
  }
  return null;
}

export default function NotFound() {
  const { pathname } = useLocation();
  const suggestion = suggestPath(pathname);

  usePageMeta({
    title: "Page not found",
    description:
      "No page at this address. Browse the targets and design runs in " +
      "Binder Base instead.",
    noindex: true,
  });

  return (
    <div className="nf-page">
      <p className="nf-code">404</p>
      <h1 className="nf-title">No page at this address</h1>
      {/* The URL itself, because half of these are a truncated paste and
          seeing where it stopped is the whole diagnosis. */}
      <p className="nf-path"><code>{pathname}</code></p>

      {suggestion && (
        <p className="nf-suggest">
          Did you mean <Link to={suggestion}>{suggestion}</Link>?
        </p>
      )}

      <p className="nf-help">
        If you followed a link to a specific target or run, it may have been
        removed, or the address may have been cut short. These are the places
        to start from:
      </p>
      <div className="nf-links">
        <Link className="pill-btn" to="/proteins">Targets</Link>
        <Link className="pill-btn" to="/runs">Runs</Link>
        <Link className="pill-btn" to="/about">About</Link>
        <Link className="pill-btn" to="/">Home</Link>
      </div>
    </div>
  );
}
