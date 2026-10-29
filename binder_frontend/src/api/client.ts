import type {
  BinderPage, Protein, ProteinDetail, RunIndex, RunSummary, Stats,
} from "../types";

async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export const getStats = (): Promise<Stats> =>
  apiFetch<Stats>("/api/stats");

export const getProteins = (): Promise<Protein[]> =>
  apiFetch<Protein[]>("/api/proteins");

export const getProtein = (id: number, signal?: AbortSignal): Promise<ProteinDetail> =>
  apiFetch<ProteinDetail>(`/api/proteins/${id}`, signal);

/** Every run with its aggregates, for the runs index. Unpaged by design --
 *  see the comment on the endpoint. Thresholds default to 2 A server-side. */
export const getRuns = (
  opts?: { placement?: number; monomer?: number },
  signal?: AbortSignal
): Promise<RunIndex> => {
  const params = new URLSearchParams();
  if (opts?.placement != null) params.set("placement_threshold", String(opts.placement));
  if (opts?.monomer != null) params.set("monomer_threshold", String(opts.monomer));
  const qs = params.toString();
  return apiFetch<RunIndex>(`/api/runs${qs ? `?${qs}` : ""}`, signal);
};

export interface BinderQuery {
  page: number;
  pageSize: number;
  sort: string;
  sortDir: string;
  status: string;
}

export const getRunBinders = (
  runId: number,
  q: BinderQuery,
  signal?: AbortSignal
): Promise<BinderPage> => {
  const params = new URLSearchParams({
    page: String(q.page),
    page_size: String(q.pageSize),
    sort: q.sort,
    sort_dir: q.sortDir,
    status: q.status,
  });
  return apiFetch<BinderPage>(`/api/runs/${runId}/binders?${params}`, signal);
};

/** Server-side run aggregate: counts, distributions and the enrichment curve.
 *  Thresholds are conventions rather than constants, so the endpoint takes
 *  them as query parameters; omitting them uses the 2.0 A defaults. */
export const getRunSummary = (
  runId: number,
  opts?: { placement?: number; monomer?: number },
  signal?: AbortSignal
): Promise<RunSummary> => {
  const params = new URLSearchParams();
  if (opts?.placement != null) params.set("placement_threshold", String(opts.placement));
  if (opts?.monomer != null) params.set("monomer_threshold", String(opts.monomer));
  const qs = params.toString();
  return apiFetch<RunSummary>(`/api/runs/${runId}/summary${qs ? `?${qs}` : ""}`, signal);
};
