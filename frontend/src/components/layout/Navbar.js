// frontend/src/components/layout/Navbar.jsx
import React from 'react';

const Navbar = () => (
  <nav className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 sticky top-0 z-50 shadow-sm">
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-white italic">TMT</div>
      <span className="text-xl font-black tracking-tighter text-gray-800 uppercase">
        Traffic <span className="text-blue-600">AI</span>
      </span>
    </div>
    <button className="px-6 py-2 bg-gray-100 border border-gray-300 text-gray-700 rounded-full hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-all font-semibold uppercase text-xs tracking-widest">
      Login / Logout
    </button>
  </nav>
);

export default Navbar;