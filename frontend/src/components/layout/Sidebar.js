import React from 'react';
import { Map, Navigation, Activity, History } from 'lucide-react';

// On change 'setScreen' par 'setActiveScreen' pour correspondre à App.js
const AsideBar = ({ activeScreen, setActiveScreen }) => {
  const menuItems = [
    { id: 'map-solo', icon: <Navigation />, label: 'Ma Voiture' },
    { id: 'map-global', icon: <Map />, label: 'Carte Globale' },
    { id: 'diagnostic', icon: <Activity />, label: 'Diagnostic' },
    { id: 'history', icon: <History />, label: 'Historique' },
  ];

  return (
    <aside className="w-20 lg:w-64 bg-slate-900 border-r border-slate-800 h-screen pt-20 flex flex-col items-center lg:items-start p-4 transition-all">
      {menuItems.map((item) => (
        <button
          key={item.id}
          // On utilise setActiveScreen ici
          onClick={() => setActiveScreen(item.id)}
          className={`w-full flex items-center gap-4 p-4 rounded-xl mb-2 transition-all ${
            activeScreen === item.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' : 'text-slate-500 hover:bg-slate-800'
          }`}
        >
          {item.icon}
          <span className="hidden lg:block font-medium">{item.label}</span>
        </button>
      ))}
    </aside>
  );
};

export default AsideBar;