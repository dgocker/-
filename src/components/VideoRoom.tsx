import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Copy, Check } from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';

interface VideoRoomProps {
  roomId: string;
  onLeave: () => void;
}

export function VideoRoom({ roomId, onLeave }: VideoRoomProps) {
  const { localStream, remoteStreams, connectionStatus, error } = useWebRTC(roomId);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout>(null);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsVideoOff(!isVideoOff);
    }
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleScreenTap = () => {
    setControlsVisible(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 5000);
  };

  useEffect(() => {
    // Auto-hide controls after 5 seconds initially
    controlsTimeoutRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 5000);
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6 text-center">
        <div className="text-white space-y-4">
          <p className="text-red-400 text-lg">{error}</p>
          <button onClick={onLeave} className="bg-white text-black px-6 py-2 rounded-full font-medium">
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const remoteStreamsArray = Array.from(remoteStreams.entries());

  return (
    <div 
      className="fixed inset-0 bg-black overflow-hidden" 
      onClick={handleScreenTap}
    >
      {/* Remote Videos Grid */}
      <div className={`absolute inset-0 z-0 grid ${
        remoteStreamsArray.length === 0 ? 'grid-cols-1' :
        remoteStreamsArray.length === 1 ? 'grid-cols-1' :
        remoteStreamsArray.length <= 4 ? 'grid-cols-2' :
        'grid-cols-3'
      } gap-1 bg-gray-900`}>
        {remoteStreamsArray.length > 0 ? (
          remoteStreamsArray.map(([userId, stream]) => (
            <div key={userId} className="relative w-full h-full overflow-hidden bg-black">
              <video
                ref={(el) => {
                  if (el) el.srcObject = stream;
                }}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
            </div>
          ))
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-white/50 space-y-4">
            <div className="w-20 h-20 rounded-full border-2 border-white/20 border-t-white animate-spin" />
            <p>Waiting for peer...</p>
            <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 cursor-pointer" onClick={(e) => { e.stopPropagation(); copyRoomId(); }}>
              <span className="font-mono">{roomId}</span>
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </div>
          </div>
        )}
      </div>

      {/* Local Video (PIP) */}
      <motion.div 
        drag
        dragConstraints={{ left: 0, right: 200, top: 0, bottom: 400 }}
        className="absolute top-4 right-4 z-20 w-32 h-48 bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-white/10"
      >
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${isVideoOff ? 'hidden' : ''} mirror`}
          style={{ transform: 'scaleX(-1)' }}
        />
        {isVideoOff && (
          <div className="w-full h-full flex items-center justify-center bg-gray-800">
            <VideoOff className="w-8 h-8 text-white/50" />
          </div>
        )}
      </motion.div>

      {/* Controls Overlay */}
      <motion.div 
        initial={{ opacity: 1, y: 0 }}
        animate={{ opacity: controlsVisible ? 1 : 0, y: controlsVisible ? 0 : 100 }}
        transition={{ duration: 0.3 }}
        className="absolute bottom-10 left-0 right-0 z-30 flex justify-center items-center gap-6 pointer-events-none"
      >
        <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-full p-4 flex items-center gap-6 pointer-events-auto shadow-2xl">
          <button
            onClick={(e) => { e.stopPropagation(); toggleMute(); }}
            className={`p-4 rounded-full transition-all ${isMuted ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
          >
            {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
          </button>

          <button
            onClick={(e) => { e.stopPropagation(); onLeave(); }}
            className="p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all transform hover:scale-105 shadow-lg shadow-red-500/20"
          >
            <PhoneOff className="w-8 h-8" />
          </button>

          <button
            onClick={(e) => { e.stopPropagation(); toggleVideo(); }}
            className={`p-4 rounded-full transition-all ${isVideoOff ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
          >
            {isVideoOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
          </button>
        </div>
      </motion.div>

      {/* Connection Status Indicator */}
      <div className="absolute top-4 left-4 z-20">
        <div className={`px-3 py-1 rounded-full backdrop-blur-md text-xs font-medium flex items-center gap-2 ${
          connectionStatus === 'connected' ? 'bg-green-500/20 text-green-400' : 
          connectionStatus === 'disconnected' ? 'bg-red-500/20 text-red-400' : 
          'bg-yellow-500/20 text-yellow-400'
        }`}>
          <div className={`w-2 h-2 rounded-full ${
            connectionStatus === 'connected' ? 'bg-green-400' : 
            connectionStatus === 'disconnected' ? 'bg-red-400' : 
            'bg-yellow-400 animate-pulse'
          }`} />
          {connectionStatus === 'connected' ? 'Connected' : 
           connectionStatus === 'disconnected' ? 'Disconnected' : 
           'Connecting...'}
        </div>
      </div>
    </div>
  );
}
