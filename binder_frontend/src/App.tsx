import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";

// Home stays in the entry chunk — it is the landing route, so an extra
// round-trip there would cost more than the split saves. Everything else is
// split out; ProteinDetail and StructurePrep in particular pull in Mol*, which
// dominates the bundle and is useless to a visitor who never opens a structure.
const ProteinList = lazy(() => import("./pages/ProteinList"));
const ProteinDetail = lazy(() => import("./pages/ProteinDetail"));
const About = lazy(() => import("./pages/About"));
const StructurePrep = lazy(() => import("./pages/StructurePrep"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const RunList = lazy(() => import("./pages/RunList"));
const NotFound = lazy(() => import("./pages/NotFound"));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Navbar />
      <main className="page-main">
        <div className="app-container">
          <Suspense fallback={<p className="status">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/proteins" element={<ProteinList />} />
              <Route path="/proteins/:id" element={<ProteinDetail />} />
              <Route path="/runs" element={<RunList />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/about" element={<About />} />
              <Route path="/structure-prep" element={<StructurePrep />} />
              {/* Last, and it must stay last. Without it React Router matched
                  nothing for an unknown path and rendered nothing, so a stale
                  or mistyped URL showed navbar, blank, footer. */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </div>
      </main>
      <Footer />
    </BrowserRouter>
  );
}
