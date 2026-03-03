import { useEffect, useRef, useState, useCallback } from 'react';

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { 
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    { 
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    { 
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
};

type SignalMessage = 
  | { type: 'user-joined'; payload: { userId: string } }
  | { type: 'user-left'; payload: { userId: string } }
  | { type: 'offer'; payload: { sdp: RTCSessionDescriptionInit; userId: string } }
  | { type: 'answer'; payload: { sdp: RTCSessionDescriptionInit; userId: string } }
  | { type: 'ice-candidate'; payload: { candidate: RTCIceCandidateInit; userId: string } };

export function useWebRTC(roomId: string) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  
  const wsRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  const addRemoteStream = useCallback((userId: string, stream: MediaStream) => {
    setRemoteStreams(prev => {
      const newMap = new Map(prev);
      newMap.set(userId, stream);
      return newMap;
    });
  }, []);

  const removeRemoteStream = useCallback((userId: string) => {
    setRemoteStreams(prev => {
      const newMap = new Map(prev);
      newMap.delete(userId);
      return newMap;
    });
  }, []);

  const createPeerConnection = useCallback((targetUserId: string) => {
    if (peersRef.current.has(targetUserId)) {
      return peersRef.current.get(targetUserId)!;
    }

    const pc = new RTCPeerConnection(STUN_SERVERS);
    
    pc.onicecandidate = (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          payload: { candidate: event.candidate, targetUserId }
        }));
      }
    };

    pc.ontrack = (event) => {
      console.log(`Received remote track from ${targetUserId}`);
      addRemoteStream(targetUserId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${targetUserId}:`, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removeRemoteStream(targetUserId);
        peersRef.current.delete(targetUserId);
      }
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    peersRef.current.set(targetUserId, pc);
    return pc;
  }, [addRemoteStream, removeRemoteStream]);

  const handleOffer = useCallback(async (offer: RTCSessionDescriptionInit, userId: string) => {
    try {
      const pc = createPeerConnection(userId);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Process pending candidates
      const pending = pendingCandidatesRef.current.get(userId);
      if (pending) {
        console.log(`Processing ${pending.length} pending candidates for ${userId}`);
        for (const candidate of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current.delete(userId);
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'answer',
          payload: { sdp: answer, targetUserId: userId }
        }));
      }
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  }, [createPeerConnection]);

  const handleAnswer = useCallback(async (answer: RTCSessionDescriptionInit, userId: string) => {
    try {
      const pc = peersRef.current.get(userId);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        
        // Process pending candidates
        const pending = pendingCandidatesRef.current.get(userId);
        if (pending) {
          console.log(`Processing ${pending.length} pending candidates for ${userId}`);
          for (const candidate of pending) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
          pendingCandidatesRef.current.delete(userId);
        }
      }
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  }, []);

  const handleCandidate = useCallback(async (candidate: RTCIceCandidateInit, userId: string) => {
    try {
      const pc = peersRef.current.get(userId);
      if (pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          console.log(`Queueing candidate for ${userId} (no remote description)`);
          const pending = pendingCandidatesRef.current.get(userId) || [];
          pending.push(candidate);
          pendingCandidatesRef.current.set(userId, pending);
        }
      } else {
        // If PC doesn't exist yet, queue it? 
        // Usually PC is created on Offer/UserJoined. 
        // If we receive candidate before Offer, we should probably queue it too, 
        // but we need to know it's for a future PC.
        console.log(`Queueing candidate for ${userId} (no PC)`);
        const pending = pendingCandidatesRef.current.get(userId) || [];
        pending.push(candidate);
        pendingCandidatesRef.current.set(userId, pending);
      }
    } catch (err) {
      console.error('Error handling candidate:', err);
    }
  }, []);

  const handleUserJoined = useCallback(async (userId: string) => {
    console.log('User joined, creating offer for', userId);
    try {
      const pc = createPeerConnection(userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'offer',
          payload: { sdp: offer, targetUserId: userId }
        }));
      }
    } catch (err) {
      console.error('Error handling user joined:', err);
    }
  }, [createPeerConnection]);

  const handleUserLeft = useCallback((userId: string) => {
    console.log('User left:', userId);
    const pc = peersRef.current.get(userId);
    if (pc) {
      pc.close();
      peersRef.current.delete(userId);
    }
    removeRemoteStream(userId);
    pendingCandidatesRef.current.delete(userId);
  }, [removeRemoteStream]);

  const toggleCamera = useCallback(async () => {
    if (!localStreamRef.current) return;
    
    const newFacingMode = facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: newFacingMode }
      });
      
      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
      
      if (oldVideoTrack) {
        newVideoTrack.enabled = oldVideoTrack.enabled;
        localStreamRef.current.removeTrack(oldVideoTrack);
        oldVideoTrack.stop();
      }
      
      localStreamRef.current.addTrack(newVideoTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
      
      // Use Promise.allSettled to ensure we don't crash if one peer fails
      await Promise.allSettled(
        Array.from(peersRef.current.values()).map(async (pc) => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) {
            await sender.replaceTrack(newVideoTrack);
          }
        })
      );
      
      setFacingMode(newFacingMode);
    } catch (err) {
      console.error('Error switching camera:', err);
    }
  }, [facingMode]);

  useEffect(() => {
    const startLocalStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode: 'user',
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 60 }
          }, 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        setLocalStream(stream);
        localStreamRef.current = stream;
      } catch (err) {
        console.error('Error accessing media devices:', err);
        setError('Не удалось получить доступ к камере или микрофону. Пожалуйста, разрешите доступ в настройках браузера.');
      }
    };

    startLocalStream();

    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!roomId || !localStream) return;

    let ws: WebSocket;
    let pingInterval: NodeJS.Timeout;
    let reconnectTimeout: NodeJS.Timeout;
    let isComponentMounted = true;

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setConnectionStatus('connected');
        ws.send(JSON.stringify({
          type: 'join-room',
          payload: { roomId }
        }));
      };

      ws.onmessage = async (event) => {
        const message: SignalMessage = JSON.parse(event.data);
        console.log('Received signal:', message.type);

        switch (message.type) {
          case 'user-joined':
            handleUserJoined(message.payload.userId);
            break;
          case 'offer':
            handleOffer(message.payload.sdp, message.payload.userId);
            break;
          case 'answer':
            handleAnswer(message.payload.sdp, message.payload.userId);
            break;
          case 'ice-candidate':
            handleCandidate(message.payload.candidate, message.payload.userId);
            break;
          case 'user-left':
            handleUserLeft(message.payload.userId);
            break;
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setConnectionStatus('disconnected');
        clearInterval(pingInterval);
        
        if (isComponentMounted) {
          console.log('Attempting to reconnect in 3 seconds...');
          reconnectTimeout = setTimeout(connectWebSocket, 3000);
        }
      };

      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    connectWebSocket();

    return () => {
      isComponentMounted = false;
      clearTimeout(reconnectTimeout);
      clearInterval(pingInterval);
      if (ws) {
        ws.onclose = null; // Prevent reconnect loop on unmount
        ws.close();
      }
      peersRef.current.forEach(pc => {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
      });
      peersRef.current.clear();
      pendingCandidatesRef.current.clear();
      setRemoteStreams(new Map());
    };
  }, [roomId, localStream, handleUserJoined, handleOffer, handleAnswer, handleCandidate, handleUserLeft]);

  return { localStream, remoteStreams, connectionStatus, error, toggleCamera };
}
