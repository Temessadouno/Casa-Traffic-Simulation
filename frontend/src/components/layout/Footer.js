import React, { useState, useEffect } from 'react';

 const Footer = () => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className="h-10 bg-slate-900 border-t border-slate-800 fixed bottom-0 w-full flex items-center justify-between px-8 text-[10px] text-slate-500 font-mono uppercase tracking-[0.2em] z-50">
      <div>Système Opérationnel - TMT-Electro v2026.04</div>
      <div>{time.toLocaleDateString('fr-FR')} | {time.toLocaleTimeString('fr-FR')}</div>
    </footer>
  );
};

export default Footer;