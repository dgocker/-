import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { io, Socket } from 'socket.io-client';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Users, LogOut, Copy, CheckCircle2, Share2, SwitchCamera, Info, X, Trash2 } from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';

const EMOJIS = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🪲', '🪳', '🕷', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊', '🐇', '🦝', '🦨', '🦡', '🦦', '🦥', '🐁', '🐀', '🐿', '🦔'];

export default function Dashboard() {
  const { user, token, logout, onlineFriends, setOnlineFriends, addOnlineFriend, removeOnlineFriend } = useStore();
  const navigate = useNavigate();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  
  // Call state
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [callActive, setCallActive] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeCallUserId, setActiveCallUserId] = useState<number | null>(null);
  const [callEmojis, setCallEmojis] = useState<string[]>([]);
  
  // Media controls
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const constraintsRef = useRef<HTMLDivElement>(null);

  const handleCallEnded = () => {
    setCallActive(false);
    setIncomingCall(null);
    setActiveCallUserId(null);
    setCallEmojis([]);
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    setLocalStream(null);
    setRemoteStream(null);
    setIsAudioMuted(false);
    setIsVideoMuted(false);
    setFacingMode('user');
  };

  const { initiateCall, cleanup, peerConnection } = useWebRTC(socket, localStream, setRemoteStream, handleCallEnded);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }

    // Fetch friends
    fetch('/api/friends', {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => setFriends(data.friends));

    // Socket setup
    const newSocket = io({
      auth: { token }
    });
    setSocket(newSocket);

    newSocket.on('online_friends', (friends: number[]) => {
      setOnlineFriends(friends);
    });

    newSocket.on('friend_online', ({ userId }) => {
      addOnlineFriend(userId);
    });

    newSocket.on('friend_offline', ({ userId }) => {
      removeOnlineFriend(userId);
    });

    newSocket.on('call_incoming', (data) => {
      setIncomingCall(data);
    });

    newSocket.on('call_accepted', ({ from }) => {
      console.log('Call accepted by', from);
      setCallActive(true);
      setActiveCallUserId(from);
      initiateCall(from);
      
      // Generate and send emojis for key verification
      const emojis = Array.from({ length: 4 }, () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);
      setCallEmojis(emojis);
      newSocket.emit('set_call_emojis', { to: from, emojis });
    });

    newSocket.on('call_emojis', ({ emojis }) => {
      setCallEmojis(emojis);
    });

    newSocket.on('call_ended', () => {
      handleCallEnded();
      cleanup();
    });

    return () => {
      newSocket.disconnect();
      cleanup();
    };
  }, [token, navigate, setOnlineFriends, addOnlineFriend, removeOnlineFriend]);

  const generateFriendLink = async () => {
    try {
      const res = await fetch('/api/friends/links', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        // Use Telegram Web App deep link format
        // Format: https://t.me/BOT_USERNAME/APP_NAME?startapp=friend-CODE
        const botName = import.meta.env.VITE_TELEGRAM_BOT_NAME || 'Vid_dm_qwe_bot';
        const appName = 'Call'; // Assuming 'Call' is the short name based on user request
        const link = `https://t.me/${botName}/${appName}?startapp=friend-${data.link.code}`;
        
        if (navigator.share) {
          try {
            await navigator.share({
              title: 'Добавить в друзья',
              text: 'Привет! Давай общаться по видеосвязи. Переходи по ссылке, чтобы добавить меня в друзья:',
              url: link
            });
          } catch (err) {
            console.error('Share failed', err);
          }
        } else {
          navigator.clipboard.writeText(link);
          setLinkCopied(true);
          setTimeout(() => setLinkCopied(false), 2000);
        }
      }
    } catch (err) {
      console.error('Failed to generate link', err);
    }
  };

  const startCall = async (friendId: number) => {
    if (!socket) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: true });
      setLocalStream(stream);
      setCallActive(true);
      setActiveCallUserId(friendId);
      
      socket.emit('call_user', {
        userToCall: friendId,
        from: user?.id,
        name: user?.first_name
      });
    } catch (err) {
      console.error('Failed to get media devices', err);
      alert('Не удалось получить доступ к камере или микрофону');
    }
  };

  const answerCall = async () => {
    if (!socket) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: true });
      setLocalStream(stream);
      setCallActive(true);
      setActiveCallUserId(incomingCall.from);
      
      socket.emit('answer_call', {
        to: incomingCall.from
      });
      setIncomingCall(null);
    } catch (err) {
      console.error('Failed to get media devices', err);
      alert('Не удалось получить доступ к камере или микрофону');
    }
  };

  const endCall = () => {
    if (!socket) return;
    if (activeCallUserId) {
      socket.emit('end_call', { to: activeCallUserId });
    } else if (incomingCall) {
      socket.emit('end_call', { to: incomingCall.from });
    }
    handleCallEnded();
    cleanup();
  };

  const toggleAudio = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsAudioMuted(!isAudioMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsVideoMuted(!isVideoMuted);
    }
  };

  const switchCamera = async () => {
    if (!localStream) return;
    const newFacingMode = facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacingMode },
        audio: true
      });
      
      // Update local stream state
      setLocalStream(newStream);
      setFacingMode(newFacingMode);
      
      // Replace track in peer connection if active
      if (peerConnection?.current) {
        const videoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnection.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(videoTrack);
        }
      }
      
      // Stop old video tracks
      localStream.getVideoTracks().forEach(track => track.stop());
      
      // Apply current mute states to new stream
      newStream.getAudioTracks().forEach(track => track.enabled = !isAudioMuted);
      newStream.getVideoTracks().forEach(track => track.enabled = !isVideoMuted);
      
    } catch (err) {
      console.error('Failed to switch camera', err);
    }
  };

  const deleteFriend = async (friendId: number) => {
    if (!confirm('Вы уверены, что хотите удалить этого друга?')) return;
    
    try {
      const res = await fetch(`/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok) {
        setFriends(friends.filter(f => f.id !== friendId));
        if (socket) {
          socket.emit('refresh_friends');
        }
      } else {
        alert('Не удалось удалить друга');
      }
    } catch (err) {
      console.error('Failed to delete friend', err);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-12">
        <div className="flex items-center gap-4">
          {user?.photo_url ? (
            <img src={user.photo_url} alt="Profile" className="w-12 h-12 rounded-full border border-zinc-800" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center">
              <span className="text-xl font-medium">{user?.first_name?.[0]}</span>
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold">{user?.first_name} {user?.last_name}</h1>
            <p className="text-sm text-zinc-400">@{user?.username}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setShowInstructions(true)}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            title="Инструкция"
          >
            <Info size={20} />
          </button>
          {user?.role === 'admin' && (
            <button 
              onClick={() => navigate('/admin')}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              Панель Админа
            </button>
          )}
          <button 
            onClick={logout}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            title="Выйти"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Users size={24} className="text-zinc-400" />
            Друзья
          </h2>
          <button 
            onClick={generateFriendLink}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {linkCopied ? <CheckCircle2 size={16} /> : <Share2 size={16} />}
            {linkCopied ? 'Скопировано!' : 'Пригласить друга'}
          </button>
        </div>

        <div className="grid gap-4">
          {friends.length === 0 ? (
            <div className="text-center py-12 bg-zinc-900/50 rounded-2xl border border-zinc-800/50">
              <p className="text-zinc-400">У вас пока нет добавленных друзей.</p>
              <p className="text-sm text-zinc-500 mt-2">Сгенерируйте ссылку и отправьте её другу!</p>
            </div>
          ) : (
            friends.map(friend => {
              const isOnline = onlineFriends.includes(friend.id);
              return (
                <motion.div 
                  key={friend.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between p-4 bg-zinc-900 rounded-xl border border-zinc-800"
                >
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      {friend.photo_url ? (
                        <img src={friend.photo_url} alt={friend.first_name} className="w-10 h-10 rounded-full" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center">
                          <span className="text-lg font-medium">{friend.first_name?.[0]}</span>
                        </div>
                      )}
                      <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-900 ${isOnline ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
                    </div>
                    <div>
                      <p className="font-medium">{friend.first_name} {friend.last_name}</p>
                      <p className="text-xs text-zinc-400">@{friend.username}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => startCall(friend.id)}
                      disabled={!isOnline || callActive}
                      className={`p-3 rounded-full transition-colors ${
                        isOnline && !callActive 
                          ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' 
                          : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                      }`}
                    >
                      <Video size={20} />
                    </button>
                    <button 
                      onClick={() => deleteFriend(friend.id)}
                      className="p-3 rounded-full bg-zinc-800 text-red-400 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                      title="Удалить друга"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </main>

      {/* Incoming Call Modal */}
      {incomingCall && !callActive && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 p-8 rounded-3xl border border-zinc-800 text-center max-w-sm w-full"
          >
            <div className="w-20 h-20 bg-zinc-800 rounded-full mx-auto mb-4 flex items-center justify-center animate-pulse">
              <Phone size={32} className="text-emerald-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2">{incomingCall.name} звонит</h3>
            <p className="text-zinc-400 mb-8">Входящий видеозвонок...</p>
            
            <div className="flex justify-center gap-6">
              <button 
                onClick={endCall}
                className="w-14 h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <PhoneOff size={24} />
              </button>
              <button 
                onClick={answerCall}
                className="w-14 h-14 bg-emerald-500 hover:bg-emerald-600 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <Phone size={24} />
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Active Call Overlay */}
      {callActive && (
        <div className="fixed inset-0 bg-black z-50 flex flex-col" ref={constraintsRef}>
          {/* Top Bar with Emojis */}
          <div className="absolute top-0 left-0 right-0 p-6 flex justify-center z-20 pointer-events-none">
            {callEmojis.length > 0 && (
              <div className="bg-zinc-900/80 backdrop-blur-md px-4 py-2 rounded-full border border-zinc-800 flex items-center gap-2 shadow-xl">
                <span className="text-xs text-zinc-400 uppercase tracking-wider mr-2">Шифрование:</span>
                <div className="flex gap-1 text-xl">
                  {callEmojis.map((emoji, i) => <span key={i}>{emoji}</span>)}
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 relative overflow-hidden">
            {/* Remote Video */}
            <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center">
              <video 
                ref={remoteVideoRef} 
                autoPlay 
                playsInline 
                className="w-full h-full object-cover"
              />
              {!remoteStream && (
                <p className="text-zinc-500 absolute">Соединение...</p>
              )}
            </div>
            
            {/* Local Video (Draggable) */}
            <motion.div 
              drag
              dragConstraints={constraintsRef}
              dragElastic={0.1}
              dragMomentum={false}
              initial={{ bottom: 32, right: 32 }}
              className="absolute w-32 h-48 md:w-48 md:h-64 bg-zinc-800 rounded-2xl overflow-hidden shadow-2xl border border-zinc-700 flex items-center justify-center cursor-grab active:cursor-grabbing z-10"
              style={{ bottom: 32, right: 32 }}
            >
               <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted 
                className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
              />
            </motion.div>
          </div>
          
          {/* Call Controls */}
          <div className="h-24 bg-zinc-950 border-t border-zinc-900 flex items-center justify-center gap-4 md:gap-6 z-20">
            <button 
              onClick={toggleAudio}
              className={`w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center text-white transition-colors ${isAudioMuted ? 'bg-zinc-800 text-red-400' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            >
              {isAudioMuted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            
            <button 
              onClick={toggleVideo}
              className={`w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center text-white transition-colors ${isVideoMuted ? 'bg-zinc-800 text-red-400' : 'bg-zinc-800 hover:bg-zinc-700'}`}
            >
              {isVideoMuted ? <VideoOff size={24} /> : <Video size={24} />}
            </button>

            <button 
              onClick={switchCamera}
              className="w-12 h-12 md:w-14 md:h-14 bg-zinc-800 hover:bg-zinc-700 rounded-full flex items-center justify-center text-white transition-colors"
            >
              <SwitchCamera size={24} />
            </button>

            <button 
              onClick={endCall}
              className="w-12 h-12 md:w-14 md:h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center text-white transition-colors shadow-lg shadow-red-500/20 ml-4"
            >
              <PhoneOff size={24} />
            </button>
          </div>
        </div>
      )}

      {/* Instructions Modal */}
      {showInstructions && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 max-w-lg w-full relative"
          >
            <button 
              onClick={() => setShowInstructions(false)}
              className="absolute top-4 right-4 text-zinc-400 hover:text-white"
            >
              <X size={24} />
            </button>
            <h3 className="text-xl font-semibold mb-4">Как пользоваться приложением</h3>
            <div className="space-y-4 text-sm text-zinc-300">
              <p>
                <strong className="text-white">1. Вход через Telegram:</strong> При переходе по ссылке-приглашению вы будете перенаправлены на страницу входа. Нажмите на виджет Telegram. 
                <br/><span className="text-zinc-500 text-xs">Примечание: Если вы используете мобильный телефон, Telegram может попросить вас подтвердить вход в самом приложении Telegram, после чего вам нужно будет вернуться в браузер и нажать кнопку входа еще раз. Это стандартная безопасность Telegram.</span>
              </p>
              <p>
                <strong className="text-white">2. Добавление друзей:</strong> Нажмите кнопку "Пригласить друга" на главном экране. Отправьте скопированную ссылку вашему другу. Когда он перейдет по ней и авторизуется, вы появитесь друг у друга в списке.
              </p>
              <p>
                <strong className="text-white">3. Звонки:</strong> Зеленый кружок возле аватарки друга означает, что он онлайн. Нажмите на иконку камеры, чтобы позвонить.
              </p>
              <p>
                <strong className="text-white">4. Шифрование:</strong> Во время звонка сверху появляются 4 эмодзи. Если у вас и у вашего собеседника они совпадают — ваш звонок надежно зашифрован (как в Telegram).
              </p>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
