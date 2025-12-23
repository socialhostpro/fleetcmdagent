import React, { useState, createContext, useContext } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import DetailPanel from './components/DetailPanel';
import AIChat from './components/AIChat';
import CanvasView from './pages/CanvasView';
import NetworkView from './pages/NetworkView';
import ClustersView from './pages/ClustersView';
import MetricsView from './pages/MetricsView';
import DockerView from './pages/DockerView';
import WorkflowDesigner from './pages/WorkflowDesigner';
import SettingsView from './pages/SettingsView';
import ArchitectureView from './pages/ArchitectureView';
import QueueView from './pages/QueueView';
import LLMMonitorView from './pages/LLMMonitorView';
import FleetDoctorView from './pages/FleetDoctorView';
import { Bell, Search, Settings, User, ChevronDown, Bot } from 'lucide-react';
import './index.css';

// Context for selected node (shared between canvas and detail panel)
const SelectedNodeContext = createContext(null);

export const useSelectedNode = () => useContext(SelectedNodeContext);

// Placeholder components for new routes
const PlaceholderView = ({ title }) => (
  <div className="flex-1 flex items-center justify-center bg-bg-primary">
    <div className="text-center">
      <h2 className="text-xl font-bold text-text-primary mb-2">{title}</h2>
      <p className="text-text-muted">Coming soon...</p>
    </div>
  </div>
);

function App() {
  const [selectedNode, setSelectedNode] = useState(null);
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);

  return (
    <SelectedNodeContext.Provider value={{ selectedNode, setSelectedNode }}>
      <Router>
        <div className="flex h-screen bg-bg-primary text-text-primary overflow-hidden">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            {/* Header */}
            <header className="h-14 bg-bg-secondary border-b border-border-subtle flex items-center px-4 shrink-0">
              {/* Left: Logo & Title */}
              <div className="flex items-center gap-3">
                <h1 className="font-bold text-lg tracking-wide text-text-primary">
                  FLEET COMMANDER
                </h1>
                <button className="flex items-center gap-1 px-2 py-1 rounded bg-bg-tertiary border border-border-subtle text-sm text-text-secondary hover:text-text-primary hover:border-border-bright transition-colors">
                  Canvas
                  <ChevronDown size={14} />
                </button>
              </div>

              {/* Center: Search */}
              <div className="flex-1 flex justify-center px-8">
                <div className="relative w-full max-w-md">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                  />
                  <input
                    type="text"
                    placeholder="Search nodes, services... (Cmd+K)"
                    className="w-full bg-bg-tertiary border border-border-subtle rounded-lg pl-10 pr-4 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-accent transition-colors"
                  />
                </div>
              </div>

              {/* Right: Actions */}
              <div className="flex items-center gap-2">
                {/* Status Badge */}
                <span className="text-xs text-status-online px-2 py-1 bg-status-online/10 rounded border border-status-online/20 mr-2">
                  SYSTEM ONLINE
                </span>

                {/* AI Assistant */}
                <button
                  onClick={() => setIsAIChatOpen(!isAIChatOpen)}
                  className={`p-2 rounded-lg transition-colors ${isAIChatOpen ? 'bg-text-accent/20 text-text-accent' : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}`}
                  title="Fleet Commander AI"
                >
                  <Bot size={18} />
                </button>

                {/* Notifications */}
                <button className="relative p-2 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <Bell size={18} />
                  <span className="absolute top-1 right-1 w-2 h-2 bg-status-error rounded-full" />
                </button>

                {/* Settings */}
                <button className="p-2 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <Settings size={18} />
                </button>

                {/* User */}
                <button className="p-2 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
                  <User size={18} />
                </button>
              </div>
            </header>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
              {/* Main View */}
              <main className="flex-1 relative overflow-hidden">
                <Routes>
                  <Route
                    path="/"
                    element={
                      <CanvasViewWrapper
                        setSelectedNode={setSelectedNode}
                      />
                    }
                  />
                  <Route path="/network" element={<NetworkView />} />
                  <Route path="/clusters" element={<ClustersView />} />
                  <Route path="/docker" element={<DockerView />} />
                  <Route path="/architecture" element={<ArchitectureView />} />
                  <Route path="/terminals" element={<PlaceholderView title="Terminals" />} />
                  <Route path="/storage" element={<PlaceholderView title="Storage / S3 View" />} />
                  <Route path="/backups" element={<PlaceholderView title="Backups View" />} />
                  <Route path="/jobs" element={<QueueView />} />
                  <Route path="/workflow" element={<WorkflowDesigner />} />
                  <Route path="/metrics" element={<MetricsView />} />
                  <Route path="/llm-monitor" element={<LLMMonitorView />} />
                  <Route path="/doctor" element={<FleetDoctorView />} />
                  <Route path="/isaac" element={<PlaceholderView title="Isaac / Robotics" />} />
                  <Route path="/comfyui" element={<PlaceholderView title="ComfyUI Link" />} />
                  <Route path="/settings" element={<SettingsView />} />
                </Routes>
              </main>

              {/* Detail Panel (shown when node selected) */}
              {selectedNode && (
                <DetailPanel
                  node={selectedNode}
                  onClose={() => setSelectedNode(null)}
                />
              )}
            </div>
          </div>

          {/* AI Chat Panel */}
          <AIChat
            isOpen={isAIChatOpen}
            onClose={() => setIsAIChatOpen(false)}
          />
        </div>
      </Router>
    </SelectedNodeContext.Provider>
  );
}

// Wrapper to pass selection handlers to CanvasView
const CanvasViewWrapper = ({ setSelectedNode }) => {
  return (
    <div className="h-full w-full">
      <CanvasView onNodeSelect={setSelectedNode} />
    </div>
  );
};

export default App;
