import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Network,
  Settings,
  Terminal,
  Container,
  HardDrive,
  Archive,
  ListTodo,
  BarChart3,
  Bot,
  Palette,
  Layers,
  Workflow,
  Boxes,
  Brain,
  Stethoscope,
} from 'lucide-react';
import clsx from 'clsx';

const navItems = [
  { icon: LayoutDashboard, path: '/', label: 'Dashboard', group: 'main' },
  { icon: Layers, path: '/clusters', label: 'Clusters', group: 'main' },
  { icon: Boxes, path: '/architecture', label: 'Services', group: 'main' },
  { icon: Network, path: '/network', label: 'Network', group: 'main' },
  { icon: Container, path: '/docker', label: 'Docker', group: 'main' },
  { icon: Terminal, path: '/terminals', label: 'Terminals', group: 'main' },
  { icon: HardDrive, path: '/storage', label: 'Storage', group: 'storage' },
  { icon: Archive, path: '/backups', label: 'Backups', group: 'storage' },
  { icon: ListTodo, path: '/jobs', label: 'Jobs', group: 'ops' },
  { icon: BarChart3, path: '/metrics', label: 'Metrics', group: 'ops' },
  { icon: Brain, path: '/llm-monitor', label: 'LLM Monitor', group: 'ops' },
  { icon: Stethoscope, path: '/doctor', label: 'Fleet Doctor', group: 'ops' },
  { icon: Workflow, path: '/workflow', label: 'Pipeline', group: 'creative' },
  { icon: Bot, path: '/isaac', label: 'Isaac', group: 'special' },
  { icon: Palette, path: '/comfyui', label: 'ComfyUI', group: 'special' },
];

const Sidebar = () => {
  const location = useLocation();

  return (
    <div className="w-16 bg-bg-secondary border-r border-border-subtle flex flex-col items-center py-4">
      {/* Logo */}
      <div className="p-2 bg-cluster-spark rounded-lg mb-6">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-white">
          <path
            d="M12 2L2 7L12 12L22 7L12 2Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 17L12 22L22 17"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 12L12 17L22 12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 flex flex-col items-center gap-1 w-full px-2 overflow-y-auto scrollbar-thin scrollbar-thumb-border-subtle scrollbar-track-transparent">
        {navItems.map((item, index) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;

          // Add separator between groups
          const showSeparator =
            index > 0 && navItems[index - 1].group !== item.group;

          return (
            <React.Fragment key={item.path}>
              {showSeparator && (
                <div className="w-8 h-px bg-border-subtle my-2" />
              )}
              <Link to={item.path} className="w-full">
                <NavItem
                  icon={<Icon size={18} />}
                  label={item.label}
                  active={isActive}
                />
              </Link>
            </React.Fragment>
          );
        })}
      </nav>

      {/* Settings at bottom */}
      <div className="mt-auto px-2 w-full">
        <div className="w-8 h-px bg-border-subtle my-2 mx-auto" />
        <Link to="/settings" className="w-full">
          <NavItem
            icon={<Settings size={18} />}
            label="Settings"
            active={location.pathname === '/settings'}
          />
        </Link>
      </div>
    </div>
  );
};

const NavItem = ({ icon, label, active }) => (
  <div
    className={clsx(
      'group relative flex items-center justify-center p-3 rounded-lg cursor-pointer transition-all duration-200',
      active
        ? 'bg-text-accent/10 text-text-accent'
        : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
    )}
  >
    {icon}
    {/* Tooltip */}
    <div className="absolute left-full ml-2 px-2 py-1 bg-bg-tertiary border border-border-default rounded text-xs text-text-primary whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
      {label}
    </div>
    {/* Active indicator */}
    {active && (
      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-text-accent rounded-r" />
    )}
  </div>
);

export default Sidebar;
