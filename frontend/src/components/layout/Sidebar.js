import React from 'react';
import { Map, Navigation, Activity, History } from 'lucide-react';

const Sidebar = ({ activeScreen, setActiveScreen }) => {
  const menuItems = [
    {
      id: 'map-solo',
      icon: <Navigation size={20} />,
      label: 'Simulation',
      sub: 'Vue véhicule & carte live',
    },
    {
      id: 'map-global',
      icon: <Map size={20} />,
      label: 'Générateur',
      sub: 'Créer un scénario SUMO',
    },
    {
      id: 'diagnostic',
      icon: <Activity size={20} />,
      label: 'Analyse',
      sub: 'Métriques & alertes temps réel',
    },
    {
      id: 'historique',
      icon: <History size={20} />,
      label: 'Historique',
      sub: 'Trajets enregistrés',
    },
  ];

  return (
    <aside className="w-16 lg:w-64 bg-white border-r border-gray-200 h-screen pt-20 flex flex-col items-center lg:items-start p-3 transition-all duration-200">
      {menuItems.map((item) => {
        const active = activeScreen === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setActiveScreen(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl mb-1 transition-all text-left ${
              active
                ? 'bg-blue-600 text-white shadow-md shadow-blue-200'
                : 'text-gray-400 hover:bg-gray-50 hover:text-gray-700'
            }`}
          >
            {/* Icône — toujours visible */}
            <span className="shrink-0">{item.icon}</span>

            {/* Texte — visible uniquement sur lg */}
            <span className="hidden lg:block min-w-0">
              <span className={`block text-sm font-semibold leading-tight truncate ${active ? 'text-white' : 'text-gray-700'}`}>
                {item.label}
              </span>
              <span className={`block text-[11px] leading-tight mt-0.5 truncate ${active ? 'text-blue-100' : 'text-gray-400'}`}>
                {item.sub}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
};

export default Sidebar;