import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Network, Settings, Terminal } from 'lucide-react';

const Sidebar = () => {
  const location = useLocation();
  
  return (
    <div className="w-16 bg-gray-900 border-r border-gray-800 flex flex-col items-center py-4 gap-6">
      <div className="p-2 bg-blue-600 rounded-lg mb-4">
        <LayoutDashboard size={24} className="text-white" />
      </div>
      
      <Link to="/">
        <NavItem icon={<LayoutDashboard size={20} />} active={location.pathname === '/'} />
      </Link>
      
      <Link to="/network">
        <NavItem icon={<Network size={20} />} active={location.pathname === '/network'} />
      </Link>
      
      <NavItem icon={<Terminal size={20} />} />
      <NavItem icon={<Settings size={20} />} />
    </div>
  );
};

const NavItem = ({ icon, active }) => (
  <div className={`p-3 rounded-lg cursor-pointer transition-colors ${active ? 'bg-gray-800 text-blue-400' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}>
    {icon}
  </div>
);

export default Sidebar;
