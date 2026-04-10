import { useState } from "react";
import { useNavigate } from "react-router-dom";
import ProteinSearchBar from "../components/ProteinSearchBar";

const EXAMPLES = ["Q9H9E1", "ANKRA2", "Homo sapiens", "Ankyrin"];

export default function Home() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  function handleSubmit(q: string) {
    navigate(q ? `/proteins?q=${encodeURIComponent(q)}` : "/proteins");
  }

  return (
    <div className="hero hero-page">
      <h1 className="hero-title">Protein Binder Design Database</h1>
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
    </div>
  );
}
