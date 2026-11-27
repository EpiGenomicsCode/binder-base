import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import HomeComplexGallery from "../components/HomeComplexGallery";
import ProteinSearchBar from "../components/ProteinSearchBar";
import { getStats } from "../api/client";
import usePageMeta, { count, DEFAULT_DESCRIPTION } from "../utils/pageMeta";
import { STAT_FIELDS } from "../utils/stats";
import type { Stats } from "../types";

const EXAMPLES = ["Tal1", "Lmo2", "Homo sapiens", "Notch1"];

export default function Home() {
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  // Swallowing the rejection left the four cards simply absent, which looks
  // identical to a site that has no data yet. Say which of the two it is.
  const [statsFailed, setStatsFailed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch(() => setStatsFailed(true));
  }, []);

  // The landing page keeps the bare site name: "Binder Base · Binder Base"
  // would be the obvious thing to get wrong here.
  usePageMeta({
    title: null,
    description: stats
      ? `${DEFAULT_DESCRIPTION} ${count(stats.binder_count)} designs across ` +
        `${count(stats.run_count)} runs against ${count(stats.protein_count)} targets.`
      : DEFAULT_DESCRIPTION,
  });

  function handleSubmit(q: string) {
    navigate(q ? `/proteins?q=${encodeURIComponent(q)}` : "/proteins");
  }

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="home-header-content">
          <h1 className="home-header-title">
            Protein Binder <span>Database</span>
          </h1>
          <HomeComplexGallery />
        </div>
      </header>
      <div className="hero hero-page">
        <p className="hero-sub">
          Search proteins by UniProt ID, gene name, organism, or protein name.
        </p>
        <ProteinSearchBar
          value={query}
          onChange={setQuery}
          onSubmit={handleSubmit}
          examples={EXAMPLES}
        />
        <button
          className="hero-browse-btn"
          onClick={() => navigate("/proteins")}
        >
          Browse all targets →
        </button>

        {stats ? (
          <div className="home-stats">
            {STAT_FIELDS.map(({ key, label }) => (
              <div className="home-stat-card" key={key}>
                <span className="home-stat-value">{count(stats[key])}</span>
                <span className="home-stat-label">{label}</span>
              </div>
            ))}
          </div>
        ) : statsFailed ? (
          <p className="stats-error">
            Site statistics are unavailable right now. Browsing and search are
            unaffected.
          </p>
        ) : null}
      </div>
    </div>
  );
}
