import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Video, ArrowRight, Shield } from 'lucide-react';

interface LobbyProps {
  onJoin: (roomId: string) => void;
}

export function Lobby({ onJoin }: LobbyProps) {
  const [roomId, setRoomId] = useState('');

  const generateRoomId = () => {
    const randomId = Math.random().toString(36).substring(2, 8);
    setRoomId(randomId);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      onJoin(roomId.trim());
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
        <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-purple-600/20 rounded-full blur-[100px]" />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="z-10 w-full max-w-md space-y-8"
      >
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-md mb-4 border border-white/10">
            <Video className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight">SimpleVideo</h1>
          <p className="text-white/60 text-lg">
            Secure, peer-to-peer video calls. No sign-up required.
          </p>
        </div>

        <div className="bg-white/5 backdrop-blur-xl rounded-3xl p-6 border border-white/10 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="roomId" className="text-sm font-medium text-white/60 ml-1">
                Room Code
              </label>
              <input
                id="roomId"
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="Enter or generate code"
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-4 text-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-white/20"
              />
            </div>

            <button
              type="submit"
              disabled={!roomId}
              className="w-full bg-white text-black font-semibold rounded-xl py-4 text-lg hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              Join Call <ArrowRight className="w-5 h-5" />
            </button>
          </form>

          <div className="mt-6 flex items-center justify-between">
            <span className="h-px flex-1 bg-white/10"></span>
            <span className="px-4 text-sm text-white/40">or</span>
            <span className="h-px flex-1 bg-white/10"></span>
          </div>

          <button
            onClick={generateRoomId}
            className="mt-6 w-full bg-white/5 hover:bg-white/10 text-white font-medium rounded-xl py-3 transition-colors border border-white/10"
          >
            Generate New Code
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 text-white/40 text-sm">
          <Shield className="w-4 h-4" />
          <span>End-to-end encrypted via WebRTC</span>
        </div>
      </motion.div>
    </div>
  );
}
