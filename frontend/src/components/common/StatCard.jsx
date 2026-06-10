// frontend/src/components/common/StatCard.jsx
import React, { memo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const StatCard = memo(({ 
  label, 
  value, 
  sub, 
  icon, 
  trend = null,
  color = "text-blue-400", 
  bgColor = "bg-slate-900/60",
  pulse = false,
  loading = false,
  onClick = null,
  className = ""
}) => {
  const trendIcon = () => {
    if (trend === 'up') return <TrendingUp size={12} className="text-green-400" />;
    if (trend === 'down') return <TrendingDown size={12} className="text-red-400" />;
    if (trend) return <Minus size={12} className="text-slate-500" />;
    return null;
  };

  return (
    <div 
      className={`${bgColor} border border-white/5 rounded-2xl p-5 hover:border-white/10 transition-all ${onClick ? 'cursor-pointer' : ''} ${className}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-slate-500 uppercase font-bold text-[10px] tracking-widest">
          <span className={color}>{icon}</span>
          {label}
        </div>
        {trendIcon()}
      </div>
      
      {loading ? (
        <div className="h-9 w-20 bg-slate-800/50 rounded-lg animate-pulse" />
      ) : (
        <div className={`text-3xl md:text-4xl font-black tabular-nums leading-none ${color} ${pulse ? "animate-pulse" : ""}`}>
          {value}
        </div>
      )}
      
      {sub && <div className="text-[10px] text-slate-600 mt-2 font-mono flex items-center gap-1">{sub}</div>}
    </div>
  );
});

StatCard.displayName = 'StatCard';

export default StatCard;