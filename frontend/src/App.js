import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Network, Briefcase, Users, Settings,
  Menu, X, Bell, Wifi, WifiOff
} from 'lucide-react';
import { useFleetWebSocket } from './hooks/useFleetWebSocket';
import { useAlertStore } from './stores';
import './index.css';

// Views
import DashboardView from './pages/DashboardView';
import TopologyView from './pages/TopologyView';
import JobsView from './pages/JobsView';
import AgentsView from './pages/AgentsView';
import SettingsView from './pages/SettingsView';

// Navigation items
const NAV_ITEMS = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/topology', icon: Network, label: 'Topology' },
  { path: '/jobs', icon: Briefcase, label: 'Jobs' },
  { path: '/agents', icon: Users, label: 'Agents' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

function Navigation() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const location = useLocation();
  const { connected } = useFleetWebSocket();
  const unacknowledgedCount = useAlertStore(state => state.unacknowledgedCount);

  return (
    <nav className={`bg-gray-800 border-r border-gray-700 flex flex-col transition-all duration-300 ${
      isCollapsed ? 'w-16' : 'w-64'
    }`}>
      {/* Header */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-700">
        {!isCollapsed && (
          <span className="font-bold text-lg text-white">Fleet Commander</span>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
        >
          {isCollapsed ? <Menu className="w-5 h-5" /> : <X className="w-5 h-5" />}
        </button>
      </div>

      {/* Nav Items */}
      <div className="flex-1 py-4">
        {NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const isActive = location.pathname === path;
          return (
            <NavLink
              key={path}
              to={path}
              className={`flex items-center gap-3 px-4 py-3 mx-2 rounded-lg transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {!isCollapsed && <span>{label}</span>}
            </NavLink>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-700">
        {/* Connection Status */}
        <div className={`flex items-center gap-2 ${isCollapsed ? 'justify-center' : ''}`}>
          {connected ? (
            <Wifi className="w-4 h-4 text-green-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-400" />
          )}
          {!isCollapsed && (
            <span className={`text-sm ${connected ? 'text-green-400' : 'text-red-400'}`}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          )}
        </div>

        {/* Alerts indicator */}
        {unacknowledgedCount > 0 && (
          <div className={`flex items-center gap-2 mt-2 ${isCollapsed ? 'justify-center' : ''}`}>
            <Bell className="w-4 h-4 text-yellow-400" />
            {!isCollapsed && (
              <span className="text-sm text-yellow-400">
                {unacknowledgedCount} alert{unacknowledgedCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

function App() {
  return (
    <Router>
      <div className="flex h-screen bg-gray-900 text-white overflow-hidden">
        <Navigation />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<DashboardView />} />
            <Route path="/topology" element={<TopologyView />} />
            <Route path="/jobs" element={<JobsView />} />
            <Route path="/agents" element={<AgentsView />} />
            <Route path="/settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
