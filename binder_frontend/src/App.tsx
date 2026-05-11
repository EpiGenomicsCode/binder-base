import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import ProteinList from "./pages/ProteinList";
import ProteinDetail from "./pages/ProteinDetail";
import About from "./pages/About";
import StructurePrep from "./pages/StructurePrep";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";

export default function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <main className="page-main">
        <div className="container">
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
