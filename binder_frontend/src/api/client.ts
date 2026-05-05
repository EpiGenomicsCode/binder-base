import type { Protein, ProteinDetail, Stats } from "../types";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export const getStats = (): Promise<Stats> =>
  apiFetch<Stats>("/api/stats");

export const getProteins = (): Promise<Protein[]> =>
  apiFetch<Protein[]>("/api/proteins");

export const getProtein = (id: number): Promise<ProteinDetail> =>
  apiFetch<ProteinDetail>(`/api/proteins/${id}`);
