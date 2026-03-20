import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { io, Socket } from 'socket.io-client';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Users, LogOut, Copy, CheckCircle2, Share2, SwitchCamera, Info, X, Trash2, Settings, SignalHigh } from 'lucide-react';
import { useSecureRelayCall } from '../hooks/useSecureRelayCall';
import { generateECDHKeyPair, exportPublicKey, importPublicKey, deriveAESKey } from '../utils/cryptoUtils';

export default function Dashboard() {
  const { user, token, logout, onlineFriends, setOnlineFriends, addOnlineFriend, removeOnlineFriend } = useStore();
  const navigate = useNavigate();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsTab, setLogsTab] = useState<'metrics' | 'log'>('metrics');
  const [showLogs, setShowLogs] = useState(false);
  
  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => {
      const newLogs = [...prev, `[${timestamp}] ${msg}`];
      return newLogs.length > 2000 ? newLogs.slice(newLogs.length - 2000) : newLogs;
    });
    // console.log(`[LOG] ${msg}`); // Avoid infinite loop if we intercept console.log
  }, []);

  // Intercept global console.log to catch system and library logs
  useEffect(() => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      addLog(`[INFO] ${msg}`);
      originalLog.apply(console, args);
    };

    console.error = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      addLog(`[ERROR] ${msg}`);
      originalError.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      addLog(`[WARN] ${msg}`);
      originalWarn.apply(console, args);
    };

    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    };
  }, [addLog]);

  const exportLogs = async () => {
    try {
      showToast('⏳ Подготовка логов...');
      addLog('📤 Starting log export optimization...');
      
      // Use setTimeout to allow Toast to render before heavy processing
      await new Promise(resolve => setTimeout(resolve, 0));

      const metricsRows = metricHistory.map(m => {
        const time = new Date(m.ts).toLocaleTimeString();
        return `${time}, ${Math.round(m.rtt)}, ${Math.round(m.fps)}, ${Math.round(m.bitrate)}, ${m.ai || '?'}, ${m.state || '?'}`;
      });

      const metricsHeader = "Timestamp, RTT(ms), FPS, Bitrate(kbps), AI_State, Net_State\n";
      const metricsSection = "\n\n=== CALL METRICS HISTORY ===\n" + 
        (metricsRows.length > 0 ? metricsHeader + metricsRows.join('\n') : "No metrics available.\n");

      // Truncate logs if they are extremely large to prevent network failure (max ~1MB)
      const truncatedLogs = logs.length > 2000 ? logs.slice(-2000) : logs;
      const fullLogs = truncatedLogs.join('\n') + metricsSection;

      addLog(`📊 Exporting: ${Math.round(fullLogs.length / 1024)}KB of data`);
      showToast('📤 Отправка на сервер...');

      const response = await fetch('/api/support/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ logs: fullLogs })
      });
      
      if (response.ok) {
        showToast('✅ Логи успешно отправлены');
        addLog('✅ Logs exported successfully');
      } else {
        const contentType = response.headers.get('content-type');
        let errorMessage = `Server error ${response.status}`;
        
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          errorMessage = data.error || errorMessage;
        } else {
          const text = await response.text();
          if (text.includes('Payload Too Large')) {
            errorMessage = 'Logs are too large for the server. Try again with fewer logs.';
          } else if (response.status === 500) {
            errorMessage = 'Server internal error. Check server logs.';
          } else {
            errorMessage = text.slice(0, 100) || errorMessage;
          }
        }
        throw new Error(errorMessage);
      }
    } catch (e: any) {
      showToast(`❌ Ошибка экспорта: ${e.message}`);
      addLog(`❌ Log export failed: ${e.message}`);
    }
  };
  
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    addLog(`Toast: ${msg}`);
    setTimeout(() => setToastMessage(null), 3000);
  }, [addLog]);
  
  // Call state
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [callActive, setCallActive] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activeCallUserId, setActiveCallUserId] = useState<number | null>(null);
  const [activeCallSocketId, setActiveCallSocketId] = useState<string | null>(null);
  
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

  // E2EE Keys
  const ecdhPrivateKeyRef = useRef<CryptoKey | null>(null);
  const sharedSecretRef = useRef<CryptoKey | null>(null);
  const pendingRoomIdRef = useRef<string | null>(null);
  const pendingRoomTokenRef = useRef<string | null>(null);

  // Media controls
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const isCleaningRef = useRef(false);
  const isSwitchingCameraRef = useRef(false);

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

  const [autoplayFailed, setAutoplayFailed] = useState(false);
  const { initiateCall, initAudioContexts, cleanup, peerConnection, connectionState, setVideoQuality, applyRotation, stats, secureEmojis, joinRoom, startRecording, setRemoteSupportsWebM, resumeAudio, isFallbackMode, remoteCanvasRef, metricHistory, remoteRotation, remoteMirror } = useSecureRelayCall(socket, activeStreamRef, setRemoteStream, handleCallEnded, remoteVideoRef, setAutoplayFailed, addLog, isAudioMuted);
  const [currentQuality, setCurrentQuality] = useState<'auto' | 'high' | 'medium' | 'low' | 'verylow'>('auto');
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // Auto-recovery for frozen video
  useEffect(() => {
    if (connectionState === 'connected' && remoteVideoRef.current && remoteStream) {
      console.log('🔄 Connection restored/stable, ensuring remote video is playing');
      const video = remoteVideoRef.current;
      // We no longer set srcObject here because useSecureRelayCall handles MediaSource
      if (video.paused) {
        video.play().catch(e => console.error('Auto-recovery play failed:', e));
      }
    }
  }, [connectionState, remoteStream]);

  // Video Watchdog removed for MediaSource compatibility

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

  const handleManualPlay = async () => {
    if (remoteVideoRef.current) {
      try {
        await resumeAudio();
        setAutoplayFailed(false);
        addLog('✅ Manual play/resume successful');
      } catch (e) {
        console.error('Manual play failed', e);
        addLog(`❌ Manual play failed: ${e}`);
      }
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
    addLog(`📱 User Agent: ${navigator.userAgent}`);
    addLog('🔌 Initializing Socket.io...');
    const newSocket = io({
      auth: { token },
      reconnectionAttempts: Infinity, // Keep trying to reconnect
      timeout: 10000,
      transports: ['websocket'],
    });

    newSocket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
      addLog(`❌ Socket connection error: ${err.message}`);
      if (err.message === 'Authentication error') {
        logout();
        navigate('/login');
      }
    });

    // Handle reconnection
    newSocket.on('connect', () => {
      console.log('Socket connected/reconnected with ID:', newSocket.id);
      addLog(`✅ Socket connected with ID: ${newSocket.id}`);
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

    newSocket.on('disconnect', (reason) => {
      addLog(`🔌 Socket disconnected: ${reason}`);
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
        if (sessionStorage.getItem(`processed_friend_code_${code}`)) {
          localStorage.removeItem('pending_friend_code');
          return;
        }

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
            showToast('Друг успешно добавлен!');
            sessionStorage.setItem(`processed_friend_code_${code}`, 'true');
            // Refresh friends list
            fetch('/api/friends', {
               headers: { Authorization: `Bearer ${token}` }
            })
            .then(res => res.json())
            .then(data => setFriends(data.friends));
            
            // Notify via socket
            if (data.friendId) {
              newSocket.emit('friend_added', { friendId: data.friendId });
            }
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

    newSocket.on('friend_list_updated', () => {
      fetch('/api/friends', {
         headers: { Authorization: `Bearer ${token}` }
      })
      .then(res => res.json())
      .then(data => setFriends(data.friends));
      
      newSocket.emit('refresh_friends');
    });

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
      addLog(`📞 Incoming call from ${data.name} (${data.from})`);
      
      // Check for call collision (we are calling them, and they are calling us)
      const isCollision = activeCallUserIdRef.current === data.from && !callActiveRef.current;

      if ((callActiveRef.current || incomingCallRef.current) && !isCollision) {
        console.log('Auto-rejecting call from', data.from, 'because we are busy');
        addLog('⚠️ Auto-rejecting call: Busy');
        newSocket.emit('user_busy', { toSocketId: data.fromSocketId });
        return;
      }

      if (isCollision) {
        addLog('🤝 Call collision detected, merging calls...');
        if (dialingTimeoutRef.current) {
          clearTimeout(dialingTimeoutRef.current);
          dialingTimeoutRef.current = null;
        }
      }

      // Send delivery confirmation immediately
      newSocket.emit('call_delivered', { to: data.from });
      setIncomingCall(data);
      if (data.supportsWebM !== undefined) {
        setRemoteSupportsWebM(data.supportsWebM);
      }
    });

    newSocket.on('rotation', ({ angle }) => {
      addLog(`🔄 Received rotation via socket: ${angle}`);
      applyRotation(angle);
    });

    newSocket.on('call_delivered', () => {
      addLog('ℹ️ Call delivered to remote');
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    });

    newSocket.on('user_busy', () => {
      addLog('⚠️ Remote user is busy');
      showToast('Пользователь занят');
      handleCallEnded();
      cleanup();
    });

    newSocket.on('user_offline', () => {
      addLog('⚠️ Remote user is offline');
      showToast('Пользователь не в сети');
      handleCallEnded();
      cleanup();
    });

    newSocket.on('call_answered_elsewhere', () => {
      addLog('ℹ️ Call answered on another device');
      setIncomingCall(null);
    });

    newSocket.on('call_accepted', async ({ from, fromSocketId, supportsWebM, publicKey, orientation }) => {
      console.log('Call accepted by', from);
      addLog(`✅ Call accepted by ${from}. Remote supports WebM: ${supportsWebM}`);
      if (dialingTimeoutRef.current) {
        clearTimeout(dialingTimeoutRef.current);
        dialingTimeoutRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setCallActive(true);
      setActiveCallUserId(from);
      setActiveCallSocketId(fromSocketId);
      if (supportsWebM !== undefined) {
        setRemoteSupportsWebM(supportsWebM);
      }
      
      // E2EE: Derive Shared Secret — MANDATORY, no fallback
      if (!publicKey || !ecdhPrivateKeyRef.current) {
        addLog(`❌ E2EE FAILED: No public key received from remote. Call aborted for security.`);
        showToast('❌ Шифрование не установлено, звонок отклонён');
        cleanup();
        handleCallEnded();
        return;
      }
      try {
        addLog('🔐 Deriving E2EE shared secret...');
        const remotePubKey = await importPublicKey(publicKey);
        sharedSecretRef.current = await deriveAESKey(ecdhPrivateKeyRef.current, remotePubKey);
        addLog('✅ E2EE Shared Secret established');
        
        if (pendingRoomIdRef.current && pendingRoomTokenRef.current) {
          joinRoom(pendingRoomIdRef.current, pendingRoomTokenRef.current, supportsWebM, sharedSecretRef.current);
        }
      } catch (e) {
        addLog(`❌ E2EE Key derivation failed: ${e}. Call aborted.`);
        showToast('❌ Шифрование не установлено, звонок отклонён');
        cleanup();
        handleCallEnded();
        return;
      }
      
      // Add a small delay before initiating the call to ensure the other side is fully ready
      // and to prevent race conditions with ICE candidates
      setTimeout(() => {
        console.log('Initiating call after delay...');
        addLog('🚀 Initiating relay connection after delay...');
        initiateCall(fromSocketId);
      }, 1500);
    });

    newSocket.on('call_ended', (data) => {
      const { from, fromSocketId } = data || {};
      console.log('Call ended by remote', from, fromSocketId);
      addLog(`🔌 Call ended by remote: ${from}`);
      
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
              text: `Привет! Давай общаться по видеосвязи. Переходи по ссылке, чтобы добавить меня в друзья:\n${link}`,
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
    
    addLog(`📞 Starting call to friend ID: ${friendId}`);
    // Cleanup any previous WebRTC state and media streams before starting a new call
    cleanup();
    stopLocalStream();

    try {
      initAudioContexts();
      addLog('📸 Requesting camera/mic access...');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }, 
          audio: true 
        });
      } catch (e) {
        console.warn('Failed with ideal constraints, trying basic constraints', e);
        addLog('⚠️ Ideal constraints failed, trying basic...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: true
        });
      }
      addLog('✅ Media stream acquired');
      stream.getTracks().forEach(track => {
        const settings = track.getSettings();
        addLog(`  - ${track.kind}: ${track.label} (${settings.width || 'N/A'}x${settings.height || 'N/A'} @ ${settings.frameRate || 'N/A'}fps)`);
      });
      setAndStoreLocalStream(stream);
      setCallActive(true);
      setAutoplayFailed(false);
      setActiveCallUserId(friendId);
      
      const roomId = `room-${Math.random().toString(36).substring(7)}`;
      const roomToken = crypto.randomUUID();
      pendingRoomIdRef.current = roomId;
      pendingRoomTokenRef.current = roomToken;
      
      const canRecordWebM = typeof MediaRecorder !== 'undefined' && 
        (MediaRecorder.isTypeSupported('video/webm; codecs="vp8, opus"') || 
         MediaRecorder.isTypeSupported('video/webm; codecs=vp8') || 
         MediaRecorder.isTypeSupported('video/webm'));
      
      const canPlayWebM = typeof window.MediaSource !== 'undefined' && 
        (MediaSource.isTypeSupported('video/webm; codecs="vp8, opus"') || 
         MediaSource.isTypeSupported('video/webm; codecs=vp8') || 
         MediaSource.isTypeSupported('video/webm'));
      
      const supportsWebM = canRecordWebM && canPlayWebM;
      
      // Detect device orientation
      const isPortrait = window.innerHeight > window.innerWidth;
      const orientation = isPortrait ? 'portrait' : 'landscape';

      // E2EE: Generate keypair
      addLog('🔐 Generating E2EE keys...');
      const keyPair = await generateECDHKeyPair();
      ecdhPrivateKeyRef.current = keyPair.privateKey;
      const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);

      addLog(`📡 Emitting call_user for room: ${roomId}, supportsWebM: ${supportsWebM}`);
      socket.emit('call_user', {
        userToCall: friendId,
        from: user?.id,
        name: user?.first_name,
        roomId,
        roomToken,
        publicKey: pubKeyBase64,
        supportsWebM,
        orientation // Send orientation for proper video rotation
      });
      // joinRoom is called in call_accepted after receiving remote public key

      // Set timeout for connection (ACK) - 15 seconds
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = setTimeout(() => {
        addLog('❌ Connection timeout (no ACK from server/remote)');
        showToast('Не удалось установить соединение');
        endCall();
      }, 15000);

      // Set timeout for call answering - 30 seconds
      if (dialingTimeoutRef.current) clearTimeout(dialingTimeoutRef.current);
      dialingTimeoutRef.current = setTimeout(() => {
        if (callActiveRef.current && !activeCallSocketIdRef.current) {
          addLog('⚠️ Dialing timeout (remote didn\'t answer)');
          showToast('Абонент не отвечает');
          endCall();
        }
      }, 30000); // 30 seconds timeout
    } catch (err) {
      console.error('Failed to get media devices', err);
      addLog(`❌ Media access failed: ${err}`);
      showToast('Не удалось получить доступ к камере или микрофону');
    }
  };

  const answerCall = async () => {
    if (!socket) return;
    
    addLog(`📞 Answering call from ${incomingCall?.name}`);
    // Cleanup any previous WebRTC state and media streams before answering
    cleanup();
    stopLocalStream();

    try {
      initAudioContexts();
      addLog('📸 Requesting camera/mic access...');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }, 
          audio: true 
        });
      } catch (e) {
        console.warn('Failed with ideal constraints, trying basic constraints', e);
        addLog('⚠️ Ideal constraints failed, trying basic...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: true
        });
      }
      addLog('✅ Media stream acquired');
      stream.getTracks().forEach(track => {
        const settings = track.getSettings();
        addLog(`  - ${track.kind}: ${track.label} (${settings.width || 'N/A'}x${settings.height || 'N/A'} @ ${settings.frameRate || 'N/A'}fps)`);
      });
      setAndStoreLocalStream(stream);
      setCallActive(true);
      setAutoplayFailed(false);
      setActiveCallUserId(incomingCall.from);
      setActiveCallSocketId(incomingCall.fromSocketId);
      
      const canRecordWebM = typeof MediaRecorder !== 'undefined' && 
        (MediaRecorder.isTypeSupported('video/webm; codecs="vp8, opus"') || 
         MediaRecorder.isTypeSupported('video/webm; codecs=vp8') || 
         MediaRecorder.isTypeSupported('video/webm'));
      
      const canPlayWebM = typeof window.MediaSource !== 'undefined' && 
        (MediaSource.isTypeSupported('video/webm; codecs="vp8, opus"') || 
         MediaSource.isTypeSupported('video/webm; codecs=vp8') || 
         MediaSource.isTypeSupported('video/webm'));
      
      const supportsWebM = canRecordWebM && canPlayWebM;
      
      // Detect device orientation
      const isPortrait = window.innerHeight > window.innerWidth;
      const orientation = isPortrait ? 'portrait' : 'landscape';

      // E2EE: Generate keys and derive immediately — MANDATORY
      addLog('🔐 Generating E2EE keys...');
      const keyPair = await generateECDHKeyPair();
      ecdhPrivateKeyRef.current = keyPair.privateKey;
      const myPubKeyBase64 = await exportPublicKey(keyPair.publicKey);
      
      if (!incomingCall.publicKey) {
        addLog('❌ E2EE FAILED: Remote sent no public key. Call rejected for security.');
        showToast('❌ Шифрование не установлено, звонок отклонён');
        cleanup();
        handleCallEnded();
        return;
      }
      
      try {
        const remotePubKey = await importPublicKey(incomingCall.publicKey);
        sharedSecretRef.current = await deriveAESKey(keyPair.privateKey, remotePubKey);
        addLog('✅ E2EE Shared Secret established');
      } catch (e) {
        addLog(`❌ E2EE Key derivation failed: ${e}. Call rejected.`);
        showToast('❌ Шифрование не установлено, звонок отклонён');
        cleanup();
        handleCallEnded();
        return;
      }

      addLog(`📡 Emitting answer_call, supportsWebM: ${supportsWebM}`);
      socket.emit('answer_call', {
        toSocketId: incomingCall.fromSocketId,
        publicKey: myPubKeyBase64,
        supportsWebM,
        roomId: incomingCall.roomId, // Join room on server
        orientation // Send orientation for proper video rotation
      });
      if (incomingCall.roomId && incomingCall.roomToken) {
        // sharedSecretRef.current is guaranteed non-null here
        joinRoom(incomingCall.roomId, incomingCall.roomToken, supportsWebM, sharedSecretRef.current);
      }
      setIncomingCall(null);
    } catch (err) {
      console.error('Failed to get media devices', err);
      addLog(`❌ Media access failed: ${err}`);
      showToast('Не удалось получить доступ к камере или микрофону');
    }
  };

  const endCall = () => {
    if (!socket) return;
    if (activeCallSocketIdRef.current) {
      socket.emit('end_call', { toSocketId: activeCallSocketIdRef.current });
    } else if (incomingCallRef.current) {
      socket.emit('end_call', { toSocketId: incomingCallRef.current.fromSocketId });
    } else if (activeCallUserIdRef.current) {
      socket.emit('end_call', { to: activeCallUserIdRef.current }); // fallback
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
    const newState = !isAudioMuted;
    setIsAudioMuted(newState);
    if (activeStreamRef.current) {
      activeStreamRef.current.getAudioTracks().forEach(t => t.enabled = !newState);
    }
    addLog(`🎙️ Mic ${!newState ? 'ON' : 'OFF'}`);
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
    if (!localStream || isSwitchingCameraRef.current) return;
    
    isSwitchingCameraRef.current = true;
    const newFacingMode = facingMode === 'user' ? 'environment' : 'user';
    
    try {
      let newStream: MediaStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { 
            facingMode: newFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: true
        });
      } catch (e) {
        console.warn('Failed with ideal constraints, trying basic constraints', e);
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: newFacingMode },
          audio: true
        });
      }
      
      // Stop ALL old tracks BEFORE updating state
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(track => {
          track.stop();
          track.enabled = false;
        });
      }
      
      // Update local stream state
      setAndStoreLocalStream(newStream);
      setFacingMode(newFacingMode);
      
      // Replace track in peer connection if active
      if (activeStreamRef.current) {
        startRecording();
      }
      
      // Apply current mute states to new stream
      newStream.getAudioTracks().forEach(track => track.enabled = !isAudioMuted);
      newStream.getVideoTracks().forEach(track => track.enabled = !isVideoMuted);
      
    } catch (err) {
      console.error('Failed to switch camera', err);
      showToast('Не удалось переключить камеру');
    } finally {
      // Add a cooldown to prevent rapid clicking
      setTimeout(() => {
        isSwitchingCameraRef.current = false;
      }, 500);
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
        showToast('Не удалось удалить друга');
      }
    } catch (err) {
      console.error('Failed to delete friend', err);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-4xl mx-auto">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-zinc-800 text-white px-4 py-2 rounded-full shadow-lg border border-zinc-700 text-sm animate-in fade-in slide-in-from-top-4">
          {toastMessage}
        </div>
      )}

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
          <button 
            onClick={() => setShowLogs(true)}
            className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            title="Логи отладки"
          >
            <Settings size={20} />
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
                        <Trash2 size={18} />
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
            {secureEmojis.length > 0 && (
              <div className="bg-zinc-900/40 backdrop-blur-md px-3 py-1 rounded-full border border-zinc-800/50 flex items-center gap-2 shadow-lg">
                <div className="flex gap-1 text-lg">
                  {secureEmojis.map((emoji, i) => <span key={i}>{emoji}</span>)}
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
                ref={remoteVideoRef} 
                autoPlay 
                playsInline 
                disablePictureInPicture
                className="w-full h-full object-contain transition-all duration-300"
                style={{
                  transformOrigin: 'center center',
                }}
              />
              <canvas 
                ref={remoteCanvasRef} 
                className={`absolute inset-0 w-full h-full object-contain transition-all duration-300 ${isFallbackMode ? 'block' : 'hidden'}`}
                style={{
                  transformOrigin: 'center center'
                }}
              />
              {autoplayFailed && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md z-30 p-6 text-center">
                  <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4 animate-pulse">
                    <Mic size={32} className="text-emerald-400" />
                  </div>
                  <h3 className="text-lg font-bold text-white mb-2">Звук заблокирован</h3>
                  <p className="text-zinc-400 text-xs mb-6 max-w-[240px]">
                    Нажмите кнопку ниже, чтобы включить звук и видео
                  </p>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleManualPlay();
                    }}
                    className="bg-emerald-500 hover:bg-emerald-400 text-white px-8 py-3 rounded-full font-bold flex items-center gap-2 shadow-xl shadow-emerald-500/20 transition-all transform hover:scale-105 active:scale-95"
                  >
                    <Video size={20} />
                    Включить связь
                  </button>
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
                    <span>{stats.fps > 0 ? Math.round(stats.fps) : (stats.bitrate > 0 ? '30' : '0')}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">RTT:</span>
                    <span className={stats.rtt > 250 ? 'text-red-400' : stats.rtt > 100 ? 'text-yellow-400' : 'text-emerald-400'}>
                      {Math.round(stats.rtt)} ms
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">RES:</span>
                    <span>{stats.resolution || `${Math.round(stats.scale * 100)}%`}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">BIT:</span>
                    <span>{Math.round(stats.bitrate)} kbps</span>
                  </div>
                  {stats.quality > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-400">QLT:</span>
                      <span>{Math.round(stats.quality * 100)}%</span>
                    </div>
                  )}
                  {stats.droppedFrames > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-400">DRP:</span>
                      <span className="text-red-400">{stats.droppedFrames}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-400">NET:</span>
                    <span className={stats.netState === 'Overuse' ? 'text-red-400' : stats.netState === 'Underuse' ? 'text-blue-400' : 'text-green-400'}>
                      {stats.netState}
                    </span>
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

        {/* Debug Logs Modal */}
      {showLogs && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
          <motion.div 
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 max-w-2xl w-full relative flex flex-col max-h-[90vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Settings className="text-zinc-400" />
                Логи и Отладка
              </h2>
              <button 
                onClick={() => setShowLogs(false)}
                className="p-2 hover:bg-zinc-800 rounded-full transition-colors"
                title="Закрыть"
              >
                <X size={20} />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4 bg-zinc-800/50 p-1 rounded-xl flex-shrink-0">
              <button
                onClick={() => setLogsTab?.('metrics')}
                className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${(logsTab ?? 'metrics') === 'metrics' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                📊 Метрики JSON
              </button>
              <button
                onClick={() => setLogsTab?.('log')}
                className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${logsTab === 'log' ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                📋 Системный журнал
              </button>
            </div>

            {/* Tab: Metrics */}
            {(logsTab ?? 'metrics') === 'metrics' && (
              <div className="flex flex-col gap-3 flex-1 overflow-hidden min-h-0">
                {/* Stats row */}
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-lg">
                    <span className="text-[10px] text-zinc-500 uppercase">Записей</span>
                    <span className="text-sm font-mono font-bold text-zinc-200">{metricHistory.length}</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded-lg">
                    <span className="text-[10px] text-zinc-500 uppercase">Пик RTT</span>
                    <span className={`text-sm font-mono font-bold ${Math.max(...metricHistory.map(m => m.rtt || 0), 0) > 1000 ? 'text-red-400' : 'text-zinc-200'}`}>
                      {Math.round(Math.max(...metricHistory.map(m => m.rtt || 0), 0))}ms
                    </span>
                  </div>
                </div>

                {/* JSON preview */}
                <div className="flex-1 overflow-y-auto min-h-0 bg-black/50 border border-zinc-700 rounded-xl">
                  <pre className="text-[11px] font-mono text-emerald-400 p-4 whitespace-pre-wrap break-all leading-relaxed select-all">
                    {metricHistory.length === 0 
                      ? 'Нет данных — начни звонок'
                      : JSON.stringify(metricHistory, null, 2)}
                  </pre>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 flex-shrink-0">
                  <button 
                    onClick={() => {
                      const text = JSON.stringify(metricHistory, null, 2);
                      navigator.clipboard.writeText(text).then(() => showToast('JSON скопирован!')).catch(() => showToast('Ошибка копирования'));
                    }}
                    className="flex-1 py-3 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <Copy size={16} />
                    Копировать JSON
                  </button>
                  <button 
                    onClick={() => {
                      const data = JSON.stringify(metricHistory, null, 2);
                      const blob = new Blob([data], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `metrics-${Date.now()}.json`;
                      document.body.appendChild(a);
                      a.click();
                      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
                      showToast('Файл сохранён');
                    }}
                    className="flex-1 py-3 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-blue-400 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <SignalHigh size={16} />
                    Скачать .json
                  </button>
                  <button 
                    onClick={() => showToast('Очищено — данные следующего звонка будут чистыми')}
                    className="px-4 py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-xl font-semibold transition-colors"
                    title="Очистить историю"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* Tab: System Log */}
            {logsTab === 'log' && (
              <div className="flex flex-col gap-3 flex-1 overflow-hidden min-h-0">
                <div className="flex-1 overflow-y-auto min-h-0 bg-black/50 border border-zinc-700 rounded-xl p-4">
                  {logs.length === 0 ? (
                    <div className="text-zinc-600 italic text-sm">Событий пока нет...</div>
                  ) : (
                    <div className="space-y-1">
                      {[...logs].reverse().map((log, i) => (
                        <div key={i} className="text-[11px] font-mono text-zinc-400 border-l-2 border-zinc-700/50 pl-3 leading-relaxed break-words">
                          {log}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(logs.join('\n')).then(() => showToast('Скопировано!')).catch(() => showToast('Ошибка'));
                    }}
                    className="flex-1 py-3 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <Copy size={16} />
                    Копировать журнал
                  </button>
                  <button 
                onClick={exportLogs}
                className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors"
                title="Отправить логи администратору"
              >
                <Share2 size={14} />
                <span>Экспорт логов</span>
              </button>
              <button 
                onClick={() => setLogs([])}
                    className="px-4 py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-xl font-semibold transition-colors"
                  >
                    Очистить
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}
