import React, { useEffect, useRef } from 'react';
import { LogMessage } from '../types';

interface TerminalOutputProps {
  logs: LogMessage[];
  isThinking: boolean;
  t: any;
}

const TerminalOutput: React.FC<TerminalOutputProps> = ({ logs, isThinking, t }) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="bg-black/80 border border-[#FCEE09]/20 rounded-lg p-4 font-mono h-48 overflow-y-auto relative shadow-[0_0_15px_rgba(252,238,9,0.15)]">
        <div className="absolute top-2 right-2 flex gap-2">
           <div className="w-3 h-3 rounded-full bg-red-500/50"></div>
           <div className="w-3 h-3 rounded-full bg-yellow-500/50"></div>
           <div className="w-3 h-3 rounded-full bg-[#FCEE09]/50"></div>
        </div>
      <div className="text-xs text-[#FCEE09]/50 mb-2 border-b border-[#FCEE09]/10 pb-1">
        {t.process}
      </div>
      <div className="space-y-1">
        {logs.map((log) => (
          <div key={log.id} className={`text-sm ${
            log.type === 'error' ? 'text-red-500' : 
            log.type === 'success' ? 'text-[#FCEE09]' : 
            log.type === 'warning' ? 'text-[#FFB800]' : 'text-gray-400'
          }`}>
            <span className="opacity-50">[{new Date(log.timestamp).toLocaleTimeString()}]</span> {'>'} {log.text}
          </div>
        ))}
        {isThinking && (
          <div className="text-[#FCEE09] animate-pulse">
            {'>'} {t.thinking}
          </div>
        )}
      </div>
      <div ref={endRef} />
    </div>
  );
};

export default TerminalOutput;
