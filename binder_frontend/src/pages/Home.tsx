import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ProteinSearchBar from "../components/ProteinSearchBar";
import { getStats } from "../api/client";
import type { Stats } from "../types";

const EXAMPLES = ["Tal1", "Lmo2", "Homo sapiens", "Notch1"];

export default function Home() {
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  function handleSubmit(q: string) {
    navigate(q ? `/proteins?q=${encodeURIComponent(q)}` : "/proteins");
  }

  return (
    <div className="home-page">
      <div className="home-header-img-wrap">
        <img
          src="/header.webp"
          alt=""
          className="home-header-img"
          width={2501}
          height={900}
        />
      </div>
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
          Browse all proteins →
        </button>

        {stats && (
          <div className="home-stats">
            <div className="home-stat-card">
              <span className="home-stat-value">{stats.protein_count}</span>
              <span className="home-stat-label">Proteins</span>
            </div>
            <div className="home-stat-card">
              <span className="home-stat-value">{stats.run_count}</span>
              <span className="home-stat-label">Design Runs</span>
            </div>
            <div className="home-stat-card">
              <span className="home-stat-value">{stats.binder_count}</span>
              <span className="home-stat-label">Binders</span>
            </div>
            <div className="home-stat-card">
              <span className="home-stat-value">{stats.success_count}</span>
              <span className="home-stat-label">Successful</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
