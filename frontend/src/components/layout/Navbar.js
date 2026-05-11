import React from 'react';

const NavBar = () => (
  <nav className="h-16 bg-slate-900/80 backdrop-blur-md border-b border-blue-900/30 flex items-center justify-between px-8 fixed top-0 w-full z-50">
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-white italic">TMT</div>
      <span className="text-xl font-black tracking-tighter text-white uppercase">Traffic <span className="text-blue-500">AI</span></span>
    </div>
    <button className="px-6 py-2 bg-blue-600/10 border border-blue-500/50 text-blue-400 rounded-full hover:bg-blue-600 hover:text-white transition-all font-semibold uppercase text-xs tracking-widest">
      Login / Logout
    </button>
  </nav>
);

export default NavBar;