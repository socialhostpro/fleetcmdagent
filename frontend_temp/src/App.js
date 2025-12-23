import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import CanvasView from './pages/CanvasView';
import NetworkView from './pages/NetworkView';
import './index.css'; 

function App() {
  return (
    <Router>
      <div className="flex h-screen bg-black text-white overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          <header className="h-14 bg-gray-900 border-b border-gray-800 flex items-center px-6">
            <h1 className="font-bold text-lg tracking-wide">FLEET COMMANDER</h1>
            <div className="ml-auto flex items-center gap-4">
              <span className="text-xs text-green-400 px-2 py-1 bg-green-400/10 rounded border border-green-400/20">SYSTEM ONLINE</span>
            </div>
          </header>
          <main className="flex-1 relative overflow-auto">
            <Routes>
              <Route path="/" element={<CanvasView />} />
              <Route path="/network" element={<NetworkView />} />
            </Routes>
          </main>
        </div>
      </div>
    </Router>
  );
}

export default App;
