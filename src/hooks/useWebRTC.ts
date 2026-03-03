import { useEffect, useRef } from 'react';

export function useWebRTC(
  socket: any,
  localStream: MediaStream | null,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void
) {
  const peerConnection = useRef<RTCPeerConnection | null>(null);

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
        setRemoteStream(event.streams[0]);
      };

      pc.onconnectionstatechange = () => {
        console.log('Connection state changed:', pc.connectionState);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          onCallEnded();
        }
      };

      if (localStream) {
        localStream.getTracks().forEach(track => {
          pc.addTrack(track, localStream);
        });
      }

      return pc;
    };

    socket.on('webrtc_offer', async ({ offer, from }: any) => {
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
    });

    socket.on('webrtc_answer', async ({ answer }: any) => {
      console.log('Received WebRTC answer');
      if (peerConnection.current) {
        try {
          await peerConnection.current.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (e) {
          console.error('Error handling answer:', e);
        }
      }
    });

    socket.on('webrtc_ice_candidate', async ({ candidate }: any) => {
      console.log('Received ICE candidate');
      if (peerConnection.current) {
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding received ice candidate', e);
        }
      }
    });

    return () => {
      socket.off('webrtc_offer');
      socket.off('webrtc_answer');
      socket.off('webrtc_ice_candidate');
    };
  }, [socket, localStream, setRemoteStream, onCallEnded]);

  const initiateCall = async (to: number) => {
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
        socket.emit('webrtc_ice_candidate', { candidate: event.candidate, to });
      }
    };

    peerConnection.current.ontrack = (event) => {
      console.log('Received remote track');
      setRemoteStream(event.streams[0]);
    };

    peerConnection.current.onconnectionstatechange = () => {
      console.log('Connection state changed:', peerConnection.current?.connectionState);
      if (peerConnection.current?.connectionState === 'disconnected' || peerConnection.current?.connectionState === 'failed' || peerConnection.current?.connectionState === 'closed') {
        onCallEnded();
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.current?.addTrack(track, localStream);
      });
    }

    const offer = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offer);
    socket.emit('webrtc_offer', { offer, to });
  };

  const cleanup = () => {
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
  };

  return { initiateCall, cleanup };
}
