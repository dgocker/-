import { useEffect, useRef, useCallback, useState } from 'react';

export function useWebRTC(
  socket: any,
  localStreamRef: React.MutableRefObject<MediaStream | null>,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void
) {
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef(socket);
  const setRemoteStreamRef = useRef(setRemoteStream);
  const onCallEndedRef = useRef(onCallEnded);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const isRemoteDescriptionSet = useRef(false);
  const activeSocketIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const restartTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const restartAttemptsRef = useRef<number>(0);

  const [connectionState, setConnectionState] = useState<string>('new');

  useEffect(() => {
    socketRef.current = socket;
    setRemoteStreamRef.current = setRemoteStream;
    onCallEndedRef.current = onCallEnded;
  });

  const getIceServers = useCallback((): RTCIceServer[] => {
    let iceServers: RTCIceServer[] = [];
    
    const customStun = import.meta.env.VITE_STUN_URL;
    if (customStun) iceServers.push({ urls: customStun });
    
    const turnUrls = import.meta.env.VITE_TURN_URL;
    const turnUsername = import.meta.env.VITE_TURN_USERNAME;
    const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;
    if (turnUrls && turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrls.split(',').map((u: string) => u.trim()),
        username: turnUsername,
        credential: turnCredential
      });
    }
    
    iceServers.push(
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    );
    
    return iceServers;
  }, []);

  const restartIce = useCallback(async (pc: RTCPeerConnection, toSocketId: string) => {
    if (restartAttemptsRef.current >= 3) {
      console.warn('Max ICE restart attempts reached. Giving up.');
      return;
    }
    
    try {
      restartAttemptsRef.current += 1;
      console.log(`Initiating automatic ICE Restart (Attempt ${restartAttemptsRef.current})...`);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      if (socketRef.current) {
        socketRef.current.emit('webrtc_offer', { offer, toSocketId });
      }
    } catch (e) {
      console.error('Error during ICE restart:', e);
    }
  }, []);

  const createPeerConnection = useCallback((targetSocketId?: string): RTCPeerConnection => {
    // Reset state for new connection
    isRemoteDescriptionSet.current = false;
    restartAttemptsRef.current = 0;
    if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
    setConnectionState('new');
    
    if (targetSocketId) activeSocketIdRef.current = targetSocketId;
    
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    
    pc.onicecandidate = (event) => {
      if (pc !== peerConnection.current) return;
      if (event.candidate && socketRef.current) {
        console.log('Sending ICE candidate');
        socketRef.current.emit('webrtc_ice_candidate', { 
          candidate: event.candidate, 
          toSocketId: targetSocketId 
        });
      }
    };
    
    pc.ontrack = (event) => {
      if (pc !== peerConnection.current) return;
      console.log('Received remote track');
      setRemoteStreamRef.current(event.streams[0]);
    };
    
    pc.onconnectionstatechange = () => {
      if (pc !== peerConnection.current) return;
      console.log('Connection state changed:', pc.connectionState);
      setConnectionState(pc.connectionState);
      if (pc.connectionState === 'closed') {
        onCallEndedRef.current();
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      if (pc !== peerConnection.current) return;
      console.log('ICE Connection state changed:', pc.iceConnectionState);
      setConnectionState(pc.iceConnectionState);
      
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        restartAttemptsRef.current = 0;
        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      }
      
      if ((pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') 
          && isCallerRef.current && activeSocketIdRef.current) {
        console.log('Connection lost. Waiting to see if it recovers...');
        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = setTimeout(() => {
          if (peerConnection.current && 
              (peerConnection.current.iceConnectionState === 'disconnected' || 
               peerConnection.current.iceConnectionState === 'failed')) {
            restartIce(peerConnection.current, activeSocketIdRef.current!);
          }
        }, 5000);
      }
    };
    
    // Add tracks immediately upon creation
    if (localStreamRef.current) {
      console.log('Adding local tracks to peer connection');
      const tracks = localStreamRef.current.getTracks();
      tracks.sort((a, b) => a.kind.localeCompare(b.kind));
      tracks.forEach(track => pc.addTrack(track, localStreamRef.current!));
    } else {
      console.warn('No local stream available when creating peer connection');
    }
    
    peerConnection.current = pc;
    return pc;
  }, [getIceServers, localStreamRef, restartIce]);

  const processIceQueue = useCallback(async () => {
    if (!peerConnection.current || !isRemoteDescriptionSet.current) return;
    
    while (iceCandidatesQueue.current.length > 0) {
      const candidate = iceCandidatesQueue.current.shift();
      if (candidate) {
        try {
          console.log('Processing queued ICE candidate');
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding queued ice candidate', e);
        }
      }
    }
  }, []);

  const initiateCall = useCallback(async (toSocketId: string) => {
    if (!socketRef.current) {
      console.error('Socket is not initialized');
      return;
    }
    
    iceCandidatesQueue.current = [];
    isCallerRef.current = true;
    
    console.log('Initiating call to', toSocketId);
    
    const pc = createPeerConnection(toSocketId);

    try {
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(offer);
      socketRef.current.emit('webrtc_offer', { offer, toSocketId });
    } catch (e) {
      console.error('Error creating offer:', e);
    }
  }, [createPeerConnection]);

  const cleanup = useCallback(() => {
    console.log('WebRTC cleanup called');
    
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    
    if (peerConnection.current) {
      // Stop all tracks before closing
      peerConnection.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
      });
      
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    iceCandidatesQueue.current = [];
    isRemoteDescriptionSet.current = false;
    activeSocketIdRef.current = null;
    isCallerRef.current = false;
    setConnectionState('closed');
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleOffer = async ({ offer, from, fromSocketId }: any) => {
      console.log('Received WebRTC offer from', from);
      
      if (peerConnection.current) {
        console.warn('Received offer while PeerConnection exists. Closing existing connection.');
        peerConnection.current.close();
        peerConnection.current = null;
      }

      isCallerRef.current = false;
      const pc = createPeerConnection(fromSocketId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        isRemoteDescriptionSet.current = true;
        await processIceQueue();
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('Sending WebRTC answer to', fromSocketId);
        socket.emit('webrtc_answer', { answer, toSocketId: fromSocketId });
      } catch (e) {
        console.error('Error handling offer:', e);
      }
    };

    const handleAnswer = async ({ answer }: any) => {
      console.log('Received WebRTC answer');
      if (peerConnection.current) {
        try {
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(answer));
          isRemoteDescriptionSet.current = true;
          await processIceQueue();
        } catch (e) {
          console.error('Error handling answer:', e);
        }
      }
    };

    const handleIceCandidate = async ({ candidate }: any) => {
      console.log('Received ICE candidate');
      if (peerConnection.current && isRemoteDescriptionSet.current) {
         try {
           await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
         } catch (e) {
           console.error('Error adding received ice candidate', e);
         }
      } else {
         console.log('Queueing ICE candidate (remote description not set or peer connection not created)');
         iceCandidatesQueue.current.push(candidate);
      }
    };

    socket.on('webrtc_offer', handleOffer);
    socket.on('webrtc_answer', handleAnswer);
    socket.on('webrtc_ice_candidate', handleIceCandidate);

    return () => {
      socket.off('webrtc_offer', handleOffer);
      socket.off('webrtc_answer', handleAnswer);
      socket.off('webrtc_ice_candidate', handleIceCandidate);
    };
  }, [socket, createPeerConnection, processIceQueue]);

  return { initiateCall, cleanup, peerConnection, connectionState };
}
