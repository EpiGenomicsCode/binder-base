import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-content">
        <div className="footer-col">
          <div className="footer-brand">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none" aria-hidden="true">
              <circle cx="14" cy="14" r="13" stroke="#0f7173" strokeWidth="2" fill="#1a3a5c" />
              <path d="M9 8 C9 8 12 11 14 14 C16 17 19 20 19 20" stroke="#0f7173" strokeWidth="2.2" strokeLinecap="round" fill="none" />
              <path d="M9 20 C9 20 12 17 14 14 C16 11 19 8 19 8" stroke="#7ecac9" strokeWidth="2.2" strokeLinecap="round" fill="none" />
              <circle cx="9" cy="8" r="2" fill="#7ecac9" />
              <circle cx="19" cy="8" r="2" fill="#0f7173" />
              <circle cx="9" cy="20" r="2" fill="#0f7173" />
              <circle cx="19" cy="20" r="2" fill="#7ecac9" />
            </svg>
            <span>Binder Base</span>
          </div>
          <p className="footer-blurb">
            An open database of computational protein binder designs to accelerate structural biology research.
          </p>
        </div>

        <div className="footer-col">
          <h4 className="footer-col-heading">Data</h4>
          <ul className="footer-links">
            <li><Link to="/proteins">Browse Proteins</Link></li>
            <li><a href="/api/docs" target="_blank" rel="noreferrer">API Documentation</a></li>
          </ul>
        </div>

        <div className="footer-col">
          <h4 className="footer-col-heading">Cite &amp; License</h4>
          <p className="footer-blurb">
            Released under the{" "}
            <a href="https://opensource.org/licenses/MIT" target="_blank" rel="noreferrer">
              MIT License
            </a>
            . If you use this data, please cite accordingly.
          </p>
        </div>
      </div>

      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Binder Base</span>
        <a
          href="https://github.com/EpiGenomicsCode/binder-base"
          target="_blank"
          rel="noreferrer"
          className="footer-github"
        >
          GitHub ↗
        </a>
      </div>
    </footer>
  );
}
