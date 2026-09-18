import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

const NAV = [
  { section: 'OPERATIONS', items: [{ to: '/shifts', label: 'Shifts', icon: '🗓️' }] },
  { section: 'RESOURCES', items: [{ to: '/staff', label: 'Staff', icon: '👤' }] },
];

export default function Layout({ children }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">DYNAMO</div>
          <div className="brand-sub">MEDICAL EMERGENCY SOLUTIONS</div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">© {new Date().getFullYear()} Medical Emergency Solutions</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-title">Shifts</div>
          <div className="topbar-user">
            <div className="avatar">{user?.name?.slice(0, 2)?.toUpperCase() || 'U'}</div>
            <div className="user-info">
              <div className="user-name">{user?.name}</div>
              <div className="user-role">{user?.role}</div>
            </div>
            <button className="btn btn-ghost" onClick={logout}>Log out</button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
