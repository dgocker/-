import { useEffect, useRef, useCallback } from 'react';

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

  useEffect(() => {
    socketRef.current = socket;
    localStreamRef.current = localStream;
    setRemoteStreamRef.current = setRemoteStream;
    onCallEndedRef.current = onCallEnded;
  });

  useEffect(() => {
    if (!socket) return;

    const createPeerConnection = (targetUserId?: number) => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }
        ]
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
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          onCallEndedRef.current();
        }
      };

      if (localStreamRef.current) {
        console.log('Adding local tracks to peer connection');
        localStreamRef.current.getTracks().forEach(track => {
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
        } catch (e) {
          console.error('Error handling answer:', e);
        }
      }
    };

    const handleIceCandidate = async ({ candidate }: any) => {
      console.log('Received ICE candidate');
      if (peerConnection.current) {
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding received ice candidate', e);
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
    console.log('Initiating call to', to);
    peerConnection.current = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
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
      if (peerConnection.current?.connectionState === 'disconnected' || peerConnection.current?.connectionState === 'failed' || peerConnection.current?.connectionState === 'closed') {
        onCallEndedRef.current();
      }
    };

    if (localStreamRef.current) {
      console.log('Adding local tracks to peer connection (initiate)');
      localStreamRef.current.getTracks().forEach(track => {
        peerConnection.current?.addTrack(track, localStreamRef.current!);
      });
    } else {
      console.warn('No local stream available when initiating call');
    }

    try {
      const offer = await peerConnection.current.createOffer();
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
  }, []);

  return { initiateCall, cleanup };
}
