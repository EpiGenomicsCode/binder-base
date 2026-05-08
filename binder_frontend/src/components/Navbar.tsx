import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const showSearch = location.pathname !== "/";

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate(query.trim() ? `/proteins?q=${encodeURIComponent(query.trim())}` : "/proteins");
  }

  return (
    <nav className="navbar">
      <div className="navbar-content">
        <Link to="/" className="navbar-logo">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <circle cx="14" cy="14" r="13" stroke="#0f7173" strokeWidth="2" fill="#1a3a5c" />
            <path d="M9 8 C9 8 12 11 14 14 C16 17 19 20 19 20" stroke="#0f7173" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            <path d="M9 20 C9 20 12 17 14 14 C16 11 19 8 19 8" stroke="#7ecac9" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            <circle cx="9" cy="8" r="2" fill="#7ecac9" />
            <circle cx="19" cy="8" r="2" fill="#0f7173" />
            <circle cx="9" cy="20" r="2" fill="#0f7173" />
            <circle cx="19" cy="20" r="2" fill="#7ecac9" />
          </svg>
          <span className="navbar-logo-text">Binder Base</span>
        </Link>

        <div className="navbar-right">
          {showSearch && (
            <form className="navbar-search-form" onSubmit={handleSearch}>
              <input
                className="navbar-search-input"
                type="search"
                placeholder="Search proteins…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </form>
          )}
          <Link to="/" className="navbar-link">Home</Link>
          <Link to="/proteins" className="navbar-link">Browse</Link>
          <Link to="/about" className="navbar-link">About</Link>
          <a
            href="/api/docs"
            className="navbar-link"
            target="_blank"
            rel="noreferrer"
          >
            API Docs
          </a>
        </div>
      </div>
    </nav>
  );
}
