// frontend/src/App.js
import React, { useState } from 'react';
import Sidebar from './components/layout/Sidebar';
import Navbar from './components/layout/Navbar';
import Footer from './components/layout/Footer';
import MapSolo from './components/screens/MapSolo';
import MapGlobal from './components/screens/MapGlobal';
import Diagnostic from './components/screens/Diagnostic';
import Historique from './components/screens/Historique';

const App = () => {
  const [activeScreen, setActiveScreen] = useState('map-solo');

  return (
    <div className="flex h-screen bg-white text-gray-800">
      <Sidebar setActiveScreen={setActiveScreen} activeScreen={activeScreen} />

      <div className="flex flex-col flex-1">
        <Navbar />
        <main className="flex-1 relative overflow-hidden bg-gray-50">
          {activeScreen === 'map-solo' && <MapSolo />}
          {activeScreen === 'map-global' && <MapGlobal />}
          {activeScreen === 'diagnostic' && <Diagnostic />}
          {activeScreen === 'historique' && <Historique />}
        </main>
        <Footer />
      </div>
    </div>
  );
};

export default App;