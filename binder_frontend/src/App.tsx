import { BrowserRouter, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import ProteinList from "./pages/ProteinList";
import ProteinDetail from "./pages/ProteinDetail";
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
          </Routes>
        </div>
      </main>
      <Footer />
    </BrowserRouter>
  );
}
