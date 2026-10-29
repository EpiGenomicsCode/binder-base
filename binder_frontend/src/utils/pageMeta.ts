import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Per-route document title, description and canonical URL.
 *
 * SCOPE, because it is easy to assume this does more than it does: this fixes
 * the browser tab, session history, and what a bookmark is named -- everything
 * the user's own browser derives from `document.title` after React has run.
 *
 * It does NOT fix link previews. nginx serves dist/ directly, so Slack,
 * Twitter/X, LinkedIn, Discord and Zotero all fetch the static index.html and
 * parse it without executing JavaScript; nothing written here is visible to
 * them. That is why there are no og:/twitter: tags in this file -- setting them
 * from React would be inert for exactly the consumers they exist to serve. The
 * site-level fallbacks in index.html are what those readers actually get, until
 * the HTML routes are rendered server-side.
 *
 * Every route must call usePageMeta. The hook writes all three values on every
 * navigation rather than clearing them on unmount, so a route that forgets to
 * call it inherits whatever the previous page set -- which is wrong silently.
 */

export const SITE_NAME = "Binder Base";

export const DEFAULT_DESCRIPTION =
  "An open database of computational protein binder designs, with the " +
  "structures, scores and provenance for every design.";

/**
 * Absolute origin for canonical URLs.
 *
 * Canonicals must be absolute, and the deployed domain is not knowable from the
 * bundle -- ALLOWED_HOSTS is "*" and the domain only reaches the backend via an
 * env var. Set VITE_SITE_ORIGIN at build time to pin it (e.g.
 * https://binderbase.org); otherwise this falls back to the origin the page was
 * actually served from, which is right in dev and right in production whenever
 * the site has a single canonical hostname.
 */
const CONFIGURED_ORIGIN = (import.meta.env.VITE_SITE_ORIGIN ?? "")
  .trim()
  .replace(/\/+$/, "");

export function siteOrigin(): string {
  if (CONFIGURED_ORIGIN) return CONFIGURED_ORIGIN;
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** "VEGFA (P15692)" -> "VEGFA (P15692) · Binder Base"; empty -> "Binder Base". */
export function pageTitle(title?: string | null): string {
  const t = (title ?? "").trim();
  return t ? `${t} · ${SITE_NAME}` : SITE_NAME;
}

function upsert<E extends HTMLElement>(
  selector: string,
  create: () => E,
  apply: (el: E) => void
): void {
  let el = document.head.querySelector<E>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  apply(el);
}

/** Trailing slashes are stripped so /proteins and /proteins/ do not become two
 *  canonical URLs for one page. The root stays "/". */
function normalisePath(path: string): string {
  const p = path.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export interface PageMeta {
  /** The page-specific part of the title. Omit for the bare site name. */
  title?: string | null;
  /** Falls back to the site description rather than keeping the last page's. */
  description?: string | null;
  /**
   * Path to canonicalise to. Defaults to the current pathname, which already
   * excludes the query string -- so /proteins?q=TAL1 canonicalises to
   * /proteins and search permutations do not each become their own URL.
   */
  canonicalPath?: string;
}

export default function usePageMeta({
  title,
  description,
  canonicalPath,
}: PageMeta): void {
  const { pathname } = useLocation();
  const path = normalisePath(canonicalPath ?? pathname);
  const text = (description ?? "").trim() || DEFAULT_DESCRIPTION;

  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);

  useEffect(() => {
    upsert<HTMLMetaElement>(
      'meta[name="description"]',
      () => {
        const el = document.createElement("meta");
        el.setAttribute("name", "description");
        return el;
      },
      (el) => el.setAttribute("content", text)
    );
  }, [text]);

  useEffect(() => {
    const origin = siteOrigin();
    if (!origin) return;
    upsert<HTMLLinkElement>(
      'link[rel="canonical"]',
      () => {
        const el = document.createElement("link");
        el.setAttribute("rel", "canonical");
        return el;
      },
      (el) => el.setAttribute("href", `${origin}${path}`)
    );
  }, [path]);
}

/** Shared by the protein and run pages, which label the same thing. */
export function geneLabel(
  gene: string | null | undefined,
  uniprot: string | null | undefined,
  fallback: string
): string {
  if (gene && uniprot) return `${gene} (${uniprot})`;
  return gene || uniprot || fallback;
}

/** 1234 -> "1,234". Descriptions read as prose, so counts are grouped. */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}
