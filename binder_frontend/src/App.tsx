import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import Home from "./pages/Home";
import ProteinList from "./pages/ProteinList";
import ProteinDetail from "./pages/ProteinDetail";
import About from "./pages/About";
import StructurePrep from "./pages/StructurePrep";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";

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
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/proteins" element={<ProteinList />} />
            <Route path="/proteins/:id" element={<ProteinDetail />} />
            <Route path="/about" element={<About />} />
            <Route path="/structure-prep" element={<StructurePrep />} />
          </Routes>
        </div>
      </main>
      <Footer />
    </BrowserRouter>
  );
}
