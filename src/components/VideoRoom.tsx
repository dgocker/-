import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Copy, Check, SwitchCamera, Share2 } from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';

interface VideoRoomProps {
  roomId: string;
  onLeave: () => void;
}

export function VideoRoom({ roomId, onLeave }: VideoRoomProps) {
  const { localStream, remoteStreams, connectionStatus, error, toggleCamera } = useWebRTC(roomId);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [constraints, setConstraints] = useState({ left: 0, right: 0, top: 0, bottom: 0 });

  useEffect(() => {
    const updateConstraints = () => {
      setConstraints({
        left: -(window.innerWidth - 128 - 32), // 128px width, 32px padding (16px left + 16px right)
        right: 0,
        top: 0,
        bottom: window.innerHeight - 192 - 32, // 192px height, 32px padding
      });
    };
    
    updateConstraints();
    window.addEventListener('resize', updateConstraints);
    return () => window.removeEventListener('resize', updateConstraints);
  }, []);

  const shareToTelegram = () => {
    const url = `${window.location.origin}?room=${roomId}`;
    const text = 'Присоединяйтесь к моему видеозвонку:';
    window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank');
  };

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

  const shareLink = async () => {
    const url = `${window.location.origin}?room=${roomId}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Присоединяйтесь к видеозвонку',
          text: 'Нажмите на ссылку, чтобы присоединиться к видеозвонку:',
          url: url,
        });
      } catch (err) {
        console.error('Error sharing:', err);
      }
    } else {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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
            Вернуться
          </button>
        </div>
      </div>
    );
  }

  const remoteStreamsArray = Array.from(remoteStreams.entries());

  return (
    <div 
      ref={containerRef}
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
            <p>Ожидание собеседника...</p>
            <div className="flex flex-col items-center gap-4 mt-4">
              <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 cursor-pointer" onClick={(e) => { e.stopPropagation(); copyRoomId(); }}>
                <span className="font-mono">{roomId}</span>
                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <button 
                  onClick={(e) => { e.stopPropagation(); shareLink(); }}
                  className="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full font-medium flex items-center gap-2 transition-colors border border-white/10"
                >
                  <Share2 className="w-5 h-5" /> Поделиться
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); shareToTelegram(); }}
                  className="bg-[#2AABEE] hover:bg-[#229ED9] text-white px-6 py-3 rounded-full font-medium flex items-center gap-2 transition-colors shadow-lg shadow-[#2AABEE]/20"
                >
                  <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
                  </svg>
                  Telegram
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Local Video (PIP) */}
      <motion.div 
        drag
        dragConstraints={containerRef}
        dragElastic={0.1}
        dragMomentum={false}
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

          <button
            onClick={(e) => { e.stopPropagation(); toggleCamera(); }}
            className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 transition-all"
          >
            <SwitchCamera className="w-6 h-6" />
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
          {connectionStatus === 'connected' ? 'Подключено' : 
           connectionStatus === 'disconnected' ? 'Отключено' : 
           'Подключение...'}
        </div>
      </div>
    </div>
  );
}
