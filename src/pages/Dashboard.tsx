import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { io, Socket } from 'socket.io-client';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Users, LogOut, Copy, CheckCircle2, Share2, SwitchCamera, Info, X, Trash2, Settings, SignalHigh } from 'lucide-react';
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
  const [activeCallSocketId, setActiveCallSocketId] = useState<string | null>(null);
  const [callEmojis, setCallEmojis] = useState<string[]>([]);
  
  // Debug info state
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  const lastClickTimeRef = useRef(0);
  const clickCountRef = useRef(0);

  // Refs for socket event handlers
  const callActiveRef = useRef(callActive);
  const incomingCallRef = useRef(incomingCall);
  const activeCallUserIdRef = useRef(activeCallUserId);
  const activeCallSocketIdRef = useRef(activeCallSocketId);
  const dialingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { callActiveRef.current = callActive; }, [callActive]);
  useEffect(() => { incomingCallRef.current = incomingCall; }, [incomingCall]);
  useEffect(() => { activeCallUserIdRef.current = activeCallUserId; }, [activeCallUserId]);
  useEffect(() => { activeCallSocketIdRef.current = activeCallSocketId; }, [activeCallSocketId]);

  // Media controls
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const isCleaningRef = useRef(false);

  const setAndStoreLocalStream = (stream: MediaStream | null) => {
    setLocalStream(stream);
    activeStreamRef.current = stream;
  };

  const stopLocalStream = () => {
    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      activeStreamRef.current = null;
    }
    setLocalStream(null);
  };

  const handleCallEnded = () => {
    if (isCleaningRef.current) return;
    isCleaningRef.current = true;

    if (dialingTimeoutRef.current) {
      clearTimeout(dialingTimeoutRef.current);
      dialingTimeoutRef.current = null;
    }

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }

    // Explicitly clear video elements
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
      remoteVideoRef.current.pause();
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
      localVideoRef.current.pause();
    }

    stopLocalStream();

    setCallActive(false);
    setIncomingCall(null);
    setActiveCallUserId(null);
    setActiveCallSocketId(null);
    setCallEmojis([]);
    
    setIsAudioMuted(false);
    setIsVideoMuted(false);
    setFacingMode('user');
    setAutoplayFailed(false);

    setTimeout(() => {
      setRemoteStream(null);
      setLocalStream(null);
    }, 200);

    setTimeout(() => {
      isCleaningRef.current = false;
    }, 300);
  };

  const { initiateCall, cleanup, peerConnection, connectionState, setVideoQuality, stats } = useWebRTC(socket, activeStreamRef, setRemoteStream, handleCallEnded);
  const [currentQuality, setCurrentQuality] = useState<'auto' | 'high' | 'medium' | 'low' | 'verylow'>('auto');
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  const [autoplayFailed, setAutoplayFailed] = useState(false);

  // Auto-recovery for frozen video
  useEffect(() => {
    if (connectionState === 'connected' && remoteVideoRef.current && remoteStream) {
      console.log('🔄 Connection restored/stable, ensuring remote video is playing');
      const video = remoteVideoRef.current;
      if (video.srcObject !== remoteStream) {
        video.srcObject = remoteStream;
      }
      if (video.paused) {
        video.play().catch(e => console.error('Auto-recovery play failed:', e));
      }
    }
  }, [connectionState, remoteStream]);

  // Video Watchdog: Detects if video is frozen while audio/connection is fine
  useEffect(() => {
    if (!remoteStream || !remoteVideoRef.current || connectionState !== 'connected') return;

    let lastTime = 0;
    let lastFrames = 0;
    let stuckCount = 0;
    const video = remoteVideoRef.current;

    const interval = setInterval(() => {
      // If video is paused intentionally or stream is inactive, do nothing
      if (video.paused || !remoteStream.active) return;

      const currentTime = video.currentTime;
      
      // Get frame count if supported (detects video-only freeze)
      let currentFrames = 0;
      if ('getVideoPlaybackQuality' in video) {
        currentFrames = video.getVideoPlaybackQuality().totalVideoFrames;
      }

      // Check if we expect video to be moving (track exists, enabled, not muted)
      const hasActiveVideo = remoteStream.getVideoTracks().some(t => t.enabled && !t.muted && t.readyState === 'live');

      // Condition 1: Time is stuck (Total freeze)
      const isTimeStuck = currentTime > 0 && currentTime === lastTime;
      
      // Condition 2: Frames are stuck (Video freeze, Audio might be playing)
      // Only check if we actually have active video and have received at least some frames previously
      const isVideoStuck = hasActiveVideo && currentFrames > 0 && currentFrames === lastFrames;

      if (isTimeStuck || isVideoStuck) {
        stuckCount++;
        // If stuck for 4 seconds (4 checks)
        if (stuckCount > 4) {
          console.warn(`⚠️ Video Watchdog: Freeze detected (TimeStuck: ${isTimeStuck}, VideoStuck: ${isVideoStuck}), forcing restart...`);
          
          // Force restart video element
          video.pause();
          video.srcObject = null;
          
          setTimeout(() => {
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = remoteStream;
              remoteVideoRef.current.play()
                .then(() => console.log('✅ Video Watchdog: Restarted successfully'))
                .catch(e => console.error('❌ Video Watchdog: Restart failed', e));
            }
          }, 100);
          
          stuckCount = 0;
        }
      } else {
        stuckCount = 0;
        lastTime = currentTime;
        lastFrames = currentFrames;
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [remoteStream, connectionState]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video || !localStream) return;

    video.srcObject = localStream;

    const playVideo = async () => {
      try {
        await video.play();
      } catch (e: any) {
        if (e.name === 'AbortError') {
          console.log('⚠️ Local play aborted (normal race in WebRTC)');
          return;
        }
        console.error("Local video play failed:", e);
      }
    };

    playVideo();
  }, [localStream]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video || !remoteStream) return;

    video.srcObject = remoteStream;

    const playVideo = async () => {
      try {
        await video.play();
        setAutoplayFailed(false);
        console.log('✅ Remote video played successfully');
      } catch (e: any) {
        // Игнорируем race conditions — это нормально в WebRTC
        if (e.name === 'AbortError') {
          console.log('⚠️ Play aborted (normal race in WebRTC)');
          return;
        }
        console.error("Remote video play failed:", e);
        setAutoplayFailed(true);
      }
    };

    playVideo();
  }, [remoteStream]);

  const handleManualPlay = () => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.play()
        .then(() => setAutoplayFailed(false))
        .catch(console.error);
    }
  };

  const handleLocalVideoClick = () => {
    const now = Date.now();
    if (now - lastClickTimeRef.current < 500) {
      clickCountRef.current += 1;
    } else {
      clickCountRef.current = 1;
    }
    lastClickTimeRef.current = now;

    if (clickCountRef.current === 3) {
      setShowDebugInfo(prev => !prev);
      clickCountRef.current = 0;
    }
  };

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }

    // Fetch friends
    fetch('/api/friends', {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => {
      if (res.status === 401 || res.status === 403) {
        logout();
        navigate('/login');
        throw new Error('Unauthorized');
      }
      return res.json();
    })
    .then(data => setFriends(data.friends))
    .catch(err => console.error('Failed to fetch friends', err));

    // Socket setup
    const newSocket = io({
      auth: { token },
      reconnectionAttempts: Infinity, // Keep trying to reconnect
      timeout: 10000,
      transports: ['websocket'],
    });

    newSocket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
      if (err.message === 'Authentication error') {
        logout();
        navigate('/login');
      }
    });

    // Handle reconnection
    newSocket.on('connect', () => {
      console.log('Socket connected/reconnected with ID:', newSocket.id);
      // Re-fetch friends to ensure online status is up to date
      fetch('/api/friends', {
        headers: { Authorization: `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => setFriends(data.friends))
      .catch(console.error);
      
      // Notify server we are back online (if needed, though auth handshake usually handles it)
      newSocket.emit('user_online');
    });

    setSocket(newSocket);

    // Check for friend invite codes (from Telegram WebApp or LocalStorage)
    const checkFriendInvite = async () => {
      const tg = (window as any).Telegram?.WebApp;
      let code = localStorage.getItem('pending_friend_code');
      
      if (tg && tg.initDataUnsafe?.start_param && tg.initDataUnsafe.start_param.startsWith('friend-')) {
        code = tg.initDataUnsafe.start_param.replace('friend-', '');
      }

      if (code) {
        try {
          const res = await fetch('/api/friends/add', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ code })
          });
          
          const data = await res.json();
          
          if (res.ok) {
            alert('Друг успешно добавлен!');
            // Refresh friends list
            fetch('/api/friends', {
               headers: { Authorization: `Bearer ${token}` }
            })
            .then(res => res.json())
            .then(data => setFriends(data.friends));
            
            // Notify via socket
            newSocket.emit('refresh_friends');
          } else if (data.error !== 'Already friends') {
             console.error('Error adding friend:', data.error);
          }
        } catch (e) {
          console.error('Failed to add friend', e);
        } finally {
          localStorage.removeItem('pending_friend_code');
        }
      }
    };
    
    checkFriendInvite();

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
      if (callActiveRef.current || incomingCallRef.current) {
        console.log('Auto-rejecting call from', data.from, 'because we are busy');
        newSocket.emit('user_busy', { toSocketId: data.fromSocketId });
        return;
      }
      // Send delivery confirmation immediately
      newSocket.emit('call_delivered', { to: data.from });
      setIncomingCall(data);
    });

    newSocket.on('call_delivered', () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    });

    newSocket.on('user_busy', () => {
      alert('Пользователь занят');
      handleCallEnded();
      cleanup();
    });

    newSocket.on('user_offline', () => {
      alert('Пользователь не в сети');
      handleCallEnded();
      cleanup();
    });

    newSocket.on('call_answered_elsewhere', () => {
      setIncomingCall(null);
    });

    newSocket.on('call_accepted', ({ from, fromSocketId }) => {
      console.log('Call accepted by', from);
      if (dialingTimeoutRef.current) {
        clearTimeout(dialingTimeoutRef.current);
        dialingTimeoutRef.current = null;
      }
      setCallActive(true);
      setActiveCallUserId(from);
      setActiveCallSocketId(fromSocketId);
      
      // Add a small delay before initiating the call to ensure the other side is fully ready
      // and to prevent race conditions with ICE candidates
      setTimeout(() => {
        console.log('Initiating call after delay...');
        initiateCall(fromSocketId);
      }, 1500);
      
      // Generate and send emojis for key verification
      const emojis = Array.from({ length: 4 }, () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);
      setCallEmojis(emojis);
      newSocket.emit('set_call_emojis', { toSocketId: fromSocketId, emojis });
    });

    newSocket.on('call_emojis', ({ emojis }) => {
      setCallEmojis(emojis);
    });

    newSocket.on('call_ended', (data) => {
      const { from, fromSocketId } = data || {};
      console.log('Call ended by remote', from, fromSocketId);
      
      // Fallback for older server events without from/fromSocketId
      if (!from && !fromSocketId) {
        handleCallEnded();
        cleanup();
        return;
      }

      // Check if the end_call is from our active partner
      if (
        (activeCallSocketIdRef.current && activeCallSocketIdRef.current === fromSocketId) ||
        (activeCallUserIdRef.current && activeCallUserIdRef.current === from)
      ) {
        handleCallEnded();
        cleanup();
      } 
      // Check if the end_call is from the person currently ringing us
      else if (
        incomingCallRef.current && 
        (incomingCallRef.current.fromSocketId === fromSocketId || incomingCallRef.current.from === from)
      ) {
        setIncomingCall(null);
      }
      // Check if we are the caller and the person we are calling hung up before answering
      else if (
        activeCallUserIdRef.current === from && !callActiveRef.current
      ) {
         handleCallEnded();
         cleanup();
      }
      // Otherwise, ignore it! (It's from someone else we aren't talking to)
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
    
    // Cleanup any previous WebRTC state and media streams before starting a new call
    cleanup();
    stopLocalStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }, 
        audio: true 
      });
      setAndStoreLocalStream(stream);
      setCallActive(true);
      setAutoplayFailed(false);
      setActiveCallUserId(friendId);
      
      socket.emit('call_user', {
        userToCall: friendId,
        from: user?.id,
        name: user?.first_name
      });

      // Set timeout for connection (ACK) - 5 seconds
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = setTimeout(() => {
        alert('Не удалось установить соединение');
        handleCallEnded();
      }, 5000);

      // Set timeout for call answering - 30 seconds
      if (dialingTimeoutRef.current) clearTimeout(dialingTimeoutRef.current);
      dialingTimeoutRef.current = setTimeout(() => {
        if (callActiveRef.current && !activeCallSocketIdRef.current) {
          alert('Абонент не отвечает');
          endCall();
        }
      }, 30000); // 30 seconds timeout
    } catch (err) {
      console.error('Failed to get media devices', err);
      alert('Не удалось получить доступ к камере или микрофону');
    }
  };

  const answerCall = async () => {
    if (!socket) return;
    
    // Cleanup any previous WebRTC state and media streams before answering
    cleanup();
    stopLocalStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }, 
        audio: true 
      });
      setAndStoreLocalStream(stream);
      setCallActive(true);
      setAutoplayFailed(false);
      setActiveCallUserId(incomingCall.from);
      setActiveCallSocketId(incomingCall.fromSocketId);
      
      socket.emit('answer_call', {
        toSocketId: incomingCall.fromSocketId
      });
      setIncomingCall(null);
    } catch (err) {
      console.error('Failed to get media devices', err);
      alert('Не удалось получить доступ к камере или микрофону');
    }
  };

  const endCall = () => {
    if (!socket) return;
    if (activeCallSocketId) {
      socket.emit('end_call', { toSocketId: activeCallSocketId });
    } else if (incomingCall) {
      socket.emit('end_call', { toSocketId: incomingCall.fromSocketId });
    } else if (activeCallUserId) {
      socket.emit('end_call', { to: activeCallUserId }); // fallback
    }
    
    cleanup();
    handleCallEnded();
    
    setTimeout(() => {
      setRemoteStream(null);
      setLocalStream(null);
    }, 200);

    setTimeout(() => {
      if (peerConnection.current) peerConnection.current = null;
    }, 150);
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
        video: { 
          facingMode: newFacingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: true
      });
      
      // Update local stream state
      setAndStoreLocalStream(newStream);
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
              <div className="bg-zinc-900/40 backdrop-blur-md px-3 py-1 rounded-full border border-zinc-800/50 flex items-center gap-2 shadow-lg">
                <div className="flex gap-1 text-lg">
                  {callEmojis.map((emoji, i) => <span key={i}>{emoji}</span>)}
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 relative overflow-hidden">
            {/* Remote Video */}
            <div 
              className="absolute inset-0 bg-zinc-900 flex items-center justify-center"
              onClick={handleManualPlay}
            >
              <video 
                key={remoteStream ? 'remote-stream-active' : 'remote-stream-loading'}
                ref={remoteVideoRef} 
                autoPlay 
                playsInline 
                disablePictureInPicture
                className="w-full h-full object-cover"
              />
              {autoplayFailed && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm z-30">
                  <div className="bg-emerald-500 text-white px-6 py-3 rounded-full font-medium flex items-center gap-2 animate-pulse cursor-pointer shadow-xl">
                    <Video size={20} />
                    Нажмите, чтобы включить видео
                  </div>
                </div>
              )}
              {!remoteStream && (
                <div className="absolute flex flex-col items-center gap-2">
                  <p className="text-zinc-500">
                    {connectionState === 'new' && 'Инициализация...'}
                    {connectionState === 'checking' && 'Поиск пути (NAT)...'}
                    {connectionState === 'connected' && 'Подключено!'}
                    {connectionState === 'completed' && 'Соединение установлено'}
                    {connectionState === 'failed' && 'Ошибка соединения (NAT)'}
                    {connectionState === 'disconnected' && 'Отключено'}
                    {connectionState === 'closed' && 'Подключение...'}
                    {!['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'].includes(connectionState) && connectionState}
                  </p>
                  {connectionState === 'checking' && <div className="w-4 h-4 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />}
                </div>
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
              onClick={handleLocalVideoClick}
            >
               <video 
                key={localStream ? 'local-stream-active' : 'local-stream-loading'}
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted 
                className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
              />
              {/* Stats Overlay */}
              {showDebugInfo && (
                <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-mono text-emerald-400 pointer-events-none flex flex-col gap-0.5 border border-white/10">
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">FPS:</span>
                    <span>{stats.bitrate > 0 ? '30' : '0'}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">RES:</span>
                    <span>{stats.resolution}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">BIT:</span>
                    <span>{stats.bitrate} kbps</span>
                  </div>
                </div>
              )}
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

            <div className="relative">
              <button 
                onClick={() => setShowQualityMenu(!showQualityMenu)}
                className={`w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center text-white transition-colors ${showQualityMenu ? 'bg-zinc-700' : 'bg-zinc-800 hover:bg-zinc-700'}`}
                title="Качество видео"
              >
                <SignalHigh size={24} />
              </button>
              
              {showQualityMenu && (
                <div className="absolute bottom-full mb-4 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-800 rounded-xl p-2 shadow-xl flex flex-col gap-1 min-w-[140px]">
                  <button 
                    onClick={() => { setVideoQuality('high'); setCurrentQuality('high'); setShowQualityMenu(false); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${currentQuality === 'high' ? 'bg-emerald-500/10 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-300'}`}
                  >
                    HD (High)
                  </button>
                  <button 
                    onClick={() => { setVideoQuality('medium'); setCurrentQuality('medium'); setShowQualityMenu(false); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${currentQuality === 'medium' ? 'bg-emerald-500/10 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-300'}`}
                  >
                    SD (Medium)
                  </button>
                  <button 
                    onClick={() => { setVideoQuality('low'); setCurrentQuality('low'); setShowQualityMenu(false); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${currentQuality === 'low' ? 'bg-emerald-500/10 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-300'}`}
                  >
                    Low Data
                  </button>
                  <button 
                    onClick={() => { setVideoQuality('verylow'); setCurrentQuality('verylow'); setShowQualityMenu(false); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${currentQuality === 'verylow' ? 'bg-emerald-500/10 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-300'}`}
                  >
                    Very Low
                  </button>
                  <button 
                    onClick={() => { setVideoQuality('auto'); setCurrentQuality('auto'); setShowQualityMenu(false); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium text-left transition-colors ${currentQuality === 'auto' ? 'bg-emerald-500/10 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-300'}`}
                  >
                    Auto
                  </button>
                </div>
              )}
            </div>

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
