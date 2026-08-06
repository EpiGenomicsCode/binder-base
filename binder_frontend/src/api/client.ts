import type { BinderPage, Protein, ProteinDetail, Stats } from "../types";

async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export const getStats = (): Promise<Stats> =>
  apiFetch<Stats>("/api/stats");

export const getProteins = (): Promise<Protein[]> =>
  apiFetch<Protein[]>("/api/proteins");

export const getProtein = (id: number): Promise<ProteinDetail> =>
  apiFetch<ProteinDetail>(`/api/proteins/${id}`);

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
