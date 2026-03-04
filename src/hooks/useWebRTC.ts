import { useEffect, useRef, useCallback, useState } from 'react';

export function useWebRTC(
  socket: any,
  localStream: MediaStream | null,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void
) {
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef(socket);
  const localStreamRef = useRef(localStream);
  const setRemoteStreamRef = useRef(setRemoteStream);
  const onCallEndedRef = useRef(onCallEnded);
  const iceCandidatesQueue = useRef<RTCIceCandidateInit[]>([]);
  const isRemoteDescriptionSet = useRef(false);

  const [connectionState, setConnectionState] = useState<string>('new');

  useEffect(() => {
    socketRef.current = socket;
    localStreamRef.current = localStream;
    setRemoteStreamRef.current = setRemoteStream;
    onCallEndedRef.current = onCallEnded;
  });

  useEffect(() => {
    if (!socket) return;

    const processIceQueue = async () => {
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
    };

    const createPeerConnection = (targetUserId?: number) => {
      // Reset state for new connection
      iceCandidatesQueue.current = [];
      isRemoteDescriptionSet.current = false;
      setConnectionState('new');

      // Configure ICE servers
      let iceServers: RTCIceServer[] = [];

      // Add custom STUN server if configured
      const customStun = import.meta.env.VITE_STUN_URL;
      if (customStun) {
        console.log('Using custom STUN server:', customStun);
        iceServers.push({ urls: customStun });
      }

      // Add TURN servers if configured
      const turnUrls = import.meta.env.VITE_TURN_URL;
      const turnUsername = import.meta.env.VITE_TURN_USERNAME;
      const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

      if (turnUrls && turnUsername && turnCredential) {
        const urls = turnUrls.split(',').map((u: string) => u.trim());
        console.log('Using custom TURN servers:', urls);
        iceServers.push({
          urls: urls,
          username: turnUsername,
          credential: turnCredential
        });
      }

      // Always add public STUN servers as fallback (at the end)
      iceServers.push(
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      );

      const pc = new RTCPeerConnection({
        iceServers: iceServers
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Sending ICE candidate');
          socket.emit('webrtc_ice_candidate', { candidate: event.candidate, to: targetUserId });
        }
      };

      pc.ontrack = (event) => {
        console.log('Received remote track');
        setRemoteStreamRef.current(event.streams[0]);
      };

      pc.onconnectionstatechange = () => {
        console.log('Connection state changed:', pc.connectionState);
        setConnectionState(pc.connectionState);
        // Only close on 'closed'. Let 'disconnected' and 'failed' persist so user can see error or try to recover.
        if (pc.connectionState === 'closed') {
          onCallEndedRef.current();
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('ICE Connection state changed:', pc.iceConnectionState);
        setConnectionState(pc.iceConnectionState); // Use ICE state for more granular feedback
      };

      if (localStreamRef.current) {
        console.log('Adding local tracks to peer connection');
        const tracks = localStreamRef.current.getTracks();
        // Sort tracks to ensure consistent m-line order (audio first, then video)
        tracks.sort((a, b) => a.kind.localeCompare(b.kind));
        
        tracks.forEach(track => {
          pc.addTrack(track, localStreamRef.current!);
        });
      } else {
        console.warn('No local stream available when creating peer connection');
      }

      return pc;
    };

    const handleOffer = async ({ offer, from }: any) => {
      console.log('Received WebRTC offer from', from);
      if (!peerConnection.current) {
        peerConnection.current = createPeerConnection(from);
      }
      try {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
        isRemoteDescriptionSet.current = true;
        await processIceQueue();
        
        const answer = await peerConnection.current.createAnswer();
        await peerConnection.current.setLocalDescription(answer);
        console.log('Sending WebRTC answer to', from);
        socket.emit('webrtc_answer', { answer, to: from });
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
      if (peerConnection.current) {
        if (isRemoteDescriptionSet.current) {
           try {
             await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
           } catch (e) {
             console.error('Error adding received ice candidate', e);
           }
        } else {
           console.log('Queueing ICE candidate (remote description not set)');
           iceCandidatesQueue.current.push(candidate);
        }
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
  }, [socket]);

  const initiateCall = useCallback(async (to: number) => {
    const currentSocket = socketRef.current;
    if (!currentSocket) {
      console.error('Socket is not initialized');
      return;
    }
    
    // Reset state for new connection
    iceCandidatesQueue.current = [];
    isRemoteDescriptionSet.current = false;
    
    console.log('Initiating call to', to);
    
    // Configure ICE servers
    let iceServers: RTCIceServer[] = [];

    // Add custom STUN server if configured
    const customStun = import.meta.env.VITE_STUN_URL;
    if (customStun) {
      console.log('Using custom STUN server:', customStun);
      iceServers.push({ urls: customStun });
    }

    // Add TURN servers if configured
    const turnUrls = import.meta.env.VITE_TURN_URL;
    const turnUsername = import.meta.env.VITE_TURN_USERNAME;
    const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

    if (turnUrls && turnUsername && turnCredential) {
      const urls = turnUrls.split(',').map((u: string) => u.trim());
      console.log('Using custom TURN servers:', urls);
      iceServers.push({
        urls: urls,
        username: turnUsername,
        credential: turnCredential
      });
    }

    // Always add public STUN servers as fallback (at the end)
    iceServers.push(
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    );

    peerConnection.current = new RTCPeerConnection({
      iceServers: iceServers
    });

    peerConnection.current.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Sending ICE candidate to', to);
        currentSocket.emit('webrtc_ice_candidate', { candidate: event.candidate, to });
      }
    };

    peerConnection.current.ontrack = (event) => {
      console.log('Received remote track');
      setRemoteStreamRef.current(event.streams[0]);
    };

    peerConnection.current.onconnectionstatechange = () => {
      console.log('Connection state changed:', peerConnection.current?.connectionState);
      setConnectionState(peerConnection.current?.connectionState || 'closed');
      // Only close on 'closed'. Let 'disconnected' and 'failed' persist so user can see error or try to recover.
      if (peerConnection.current?.connectionState === 'closed') {
        onCallEndedRef.current();
      }
    };

    peerConnection.current.oniceconnectionstatechange = () => {
      console.log('ICE Connection state changed:', peerConnection.current?.iceConnectionState);
      setConnectionState(peerConnection.current?.iceConnectionState || 'closed');
    };

    if (localStreamRef.current) {
      console.log('Adding local tracks to peer connection (initiate)');
      const tracks = localStreamRef.current.getTracks();
      // Sort tracks to ensure consistent m-line order (audio first, then video)
      tracks.sort((a, b) => a.kind.localeCompare(b.kind));
      
      tracks.forEach(track => {
        peerConnection.current?.addTrack(track, localStreamRef.current!);
      });
    } else {
      console.warn('No local stream available when initiating call');
    }

    try {
      const offer = await peerConnection.current.createOffer({ 
        iceRestart: true,
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await peerConnection.current.setLocalDescription(offer);
      currentSocket.emit('webrtc_offer', { offer, to });
    } catch (e) {
      console.error('Error creating offer:', e);
    }
  }, []);

  const cleanup = useCallback(() => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    iceCandidatesQueue.current = [];
    isRemoteDescriptionSet.current = false;
    setConnectionState('closed');
  }, []);

  return { initiateCall, cleanup, peerConnection, connectionState };
}
