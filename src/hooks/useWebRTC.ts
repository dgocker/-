import React, { useEffect, useRef, useCallback, useState } from 'react';

const EMOJIS = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🪲', '🪳', '🕷', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊', '🐇', '🦝', '🦨', '🦡', '🦦', '🦥', '🐁', '🐀', '🐿', '🦔'];

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
  const iceServersRef = useRef<RTCIceServer[] | null>(null);

  const [connectionState, setConnectionState] = useState<string>('new');
  const [secureEmojis, setSecureEmojis] = useState<string[]>([]);

  const computeEmojis = async (localSdp: string, remoteSdp: string) => {
    try {
      const extractFingerprint = (sdp: string) => {
        const match = sdp.match(/a=fingerprint:sha-256\s+(.*)/i);
        return match ? match[1].trim() : null;
      };

      const localFp = extractFingerprint(localSdp);
      const remoteFp = extractFingerprint(remoteSdp);

      if (!localFp || !remoteFp) {
        console.warn('Could not extract fingerprints for emoji verification');
        return;
      }

      // Sort to ensure both sides get the exact same combined string
      const combined = [localFp, remoteFp].sort().join('|');
      
      const encoder = new TextEncoder();
      const data = encoder.encode(combined);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      
      const emojis = [];
      for (let i = 0; i < 4; i++) {
        const num = (hashArray[i * 2] << 8) | hashArray[i * 2 + 1];
        emojis.push(EMOJIS[num % EMOJIS.length]);
      }
      
      setSecureEmojis(emojis);
    } catch (e) {
      console.error('Error computing secure emojis:', e);
    }
  };

  const getIceServers = async (): Promise<RTCIceServer[]> => {
    if (iceServersRef.current) return iceServersRef.current;

    let servers: RTCIceServer[] = [];
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/auth/turn', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.stunUrl) {
          console.log('Using custom STUN server:', data.stunUrl);
          servers.push({ urls: data.stunUrl });
        }
        if (data.turnUrl && data.turnUsername && data.turnCredential) {
          const urls = data.turnUrl.split(',').map((u: string) => {
            let url = u.trim();
            // Force TCP transport if not explicitly specified
            if (url.startsWith('turn:') || url.startsWith('turns:')) {
              if (!url.includes('?transport=')) {
                url += '?transport=tcp';
              }
            }
            return url;
          });
          console.log('Using custom TURN servers (TCP enforced):', urls);
          servers.push({
            urls: urls,
            username: data.turnUsername,
            credential: data.turnCredential
          });
        }
      }
    } catch (e) {
      console.error('Failed to fetch TURN credentials', e);
    }

    iceServersRef.current = servers;
    return servers;
  };

  useEffect(() => {
    socketRef.current = socket;
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

    const restartIce = async (pc: RTCPeerConnection, toSocketId: string) => {
      if (restartAttemptsRef.current >= 3) {
        console.warn('Max ICE restart attempts reached. Giving up.');
        return;
      }
      
      try {
        restartAttemptsRef.current += 1;
        console.log(`Initiating automatic ICE Restart (Attempt ${restartAttemptsRef.current})...`);
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socketRef.current.emit('webrtc_offer', { offer, toSocketId });
      } catch (e) {
        console.error('Error during ICE restart:', e);
      }
    };

    const createPeerConnection = async (targetSocketId?: string) => {
      if (peerConnection.current && peerConnection.current.connectionState !== 'closed') {
        console.warn('Old PC still alive, forcing close...');
        peerConnection.current.close();
        peerConnection.current = null;
      }

      // Reset state for new connection
      iceCandidatesQueue.current = [];
      isRemoteDescriptionSet.current = false;
      restartAttemptsRef.current = 0;
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = null;
      }
      setConnectionState('new');
      if (targetSocketId) activeSocketIdRef.current = targetSocketId;

      // Configure ICE servers
      const iceServers = await getIceServers();

      if (peerConnection.current) {
        peerConnection.current.close();
      }

      const pc = new RTCPeerConnection({
        iceServers: iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        // @ts-ignore - Required for older Android WebView compatibility
        sdpSemantics: 'unified-plan'
      } as RTCConfiguration);

      pc.onicecandidate = (event) => {
        if (pc !== peerConnection.current) return;
        if (event.candidate) {
          console.log('Sending ICE candidate');
          socket.emit('webrtc_ice_candidate', { candidate: event.candidate, toSocketId: targetSocketId });
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
        // Only close on 'closed'. Let 'disconnected' and 'failed' persist so user can see error or try to recover.
        if (pc.connectionState === 'closed') {
          onCallEndedRef.current();
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc !== peerConnection.current) return;
        console.log('ICE Connection state changed:', pc.iceConnectionState);
        setConnectionState(pc.iceConnectionState); // Use ICE state for more granular feedback
        
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          // Reset attempts on successful connection
          restartAttemptsRef.current = 0;
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);

          // Check if video tracks have arrived
          setTimeout(async () => {
            if (!peerConnection.current) return;

            const receivers = peerConnection.current.getReceivers();
            const hasVideo = receivers.some(r => r.track?.kind === 'video' && r.track.readyState === 'live');

            if (!hasVideo) {
              console.warn('ICE connected, but no video tracks -> forced ICE restart');
              if (isCallerRef.current && activeSocketIdRef.current) {
                restartIce(peerConnection.current, activeSocketIdRef.current);
              }
            }
          }, 4000); // Give 4 seconds for tracks to arrive
        }
        
        // Automatic ICE Restart on connection drop
        if ((pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') && isCallerRef.current && activeSocketIdRef.current) {
          console.log('Connection lost. Waiting to see if it recovers...');
          
          // Clear any existing timeout to prevent multiple restarts
          if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
          
          // Wait 5 seconds before attempting restart. 
          // Often, 'disconnected' is temporary and WebRTC recovers on its own.
          restartTimeoutRef.current = setTimeout(() => {
            if (peerConnection.current && (peerConnection.current.iceConnectionState === 'disconnected' || peerConnection.current.iceConnectionState === 'failed')) {
              restartIce(peerConnection.current, activeSocketIdRef.current!);
            }
          }, 5000);
        }
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

    const handleOffer = async ({ offer, from, fromSocketId }: any) => {
      await new Promise(r => setTimeout(r, 80)); // micro-pause for Telegram WebView
      console.log('Received WebRTC offer from', from);
      
      // FIX: Wait for local stream to be fully acquired before answering
      // This prevents sending an Answer without media tracks on slow Android devices
      let attempts = 0;
      while (!localStreamRef.current && attempts < 50) {
        console.log('Waiting for local stream before handling offer...');
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      if (!localStreamRef.current) {
        console.error('CRITICAL: Local stream not available. Cannot handle offer.');
        return;
      }
      
      // If a peer connection already exists, close it to ensure a clean state for the new offer
      if (peerConnection.current) {
        console.warn('Received offer while PeerConnection exists. Closing existing connection.');
        peerConnection.current.close();
        peerConnection.current = null;
      }

      isCallerRef.current = false;
      peerConnection.current = await createPeerConnection(fromSocketId);

      try {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));
        isRemoteDescriptionSet.current = true;
        await processIceQueue();
        
        const answer = await peerConnection.current.createAnswer();
        
        // Smart Codec Selection: Ensure VP8 is available as a fallback for older Androids
        if (answer.sdp && !answer.sdp.includes('VP8/90000')) {
          console.warn('VP8 codec not found in SDP answer. Older devices might fail to decode video.');
        }

        await peerConnection.current.setLocalDescription(answer);
        console.log('Sending WebRTC answer to', fromSocketId);
        socket.emit('webrtc_answer', { answer, toSocketId: fromSocketId });

        if (peerConnection.current.localDescription && peerConnection.current.remoteDescription) {
          computeEmojis(peerConnection.current.localDescription.sdp, peerConnection.current.remoteDescription.sdp);
        }
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

          if (peerConnection.current.localDescription && peerConnection.current.remoteDescription) {
            computeEmojis(peerConnection.current.localDescription.sdp, peerConnection.current.remoteDescription.sdp);
          }
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
  }, [socket]);

  const initiateCall = useCallback(async (toSocketId: string) => {
    await new Promise(r => setTimeout(r, 80)); // micro-pause for Telegram WebView
    const currentSocket = socketRef.current;
    if (!currentSocket) {
      console.error('Socket is not initialized');
      return;
    }
    
    // FIX: Wait for local stream to be fully acquired before initiating
    // This prevents sending an Offer without media tracks on slow Android devices
    let attempts = 0;
    while (!localStreamRef.current && attempts < 50) {
      console.log('Waiting for local stream before initiating call...');
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    if (!localStreamRef.current) {
      console.error('CRITICAL: Local stream not available. Cannot initiate call.');
      return;
    }
    
    if (peerConnection.current && peerConnection.current.connectionState !== 'closed') {
      console.warn('Old PC still alive, forcing close...');
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    // Reset state for new connection
    iceCandidatesQueue.current = [];
    isRemoteDescriptionSet.current = false;
    restartAttemptsRef.current = 0;
    if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
    activeSocketIdRef.current = toSocketId;
    isCallerRef.current = true;
    
    console.log('Initiating call to', toSocketId);
    
    // Configure ICE servers
    const iceServers = await getIceServers();

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      iceCandidatePoolSize: 10,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      // @ts-ignore - Required for older Android WebView compatibility
      sdpSemantics: 'unified-plan'
    } as RTCConfiguration);
    peerConnection.current = pc;

    pc.onicecandidate = (event) => {
      if (pc !== peerConnection.current) return;
      if (event.candidate) {
        console.log('Sending ICE candidate to', toSocketId);
        currentSocket.emit('webrtc_ice_candidate', { candidate: event.candidate, toSocketId });
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
      // Only close on 'closed'. Let 'disconnected' and 'failed' persist so user can see error or try to recover.
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
      
      // Automatic ICE Restart on connection drop
      if ((pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') && isCallerRef.current && activeSocketIdRef.current) {
        console.log('Connection lost. Waiting to see if it recovers...');
        
        if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
        
        restartTimeoutRef.current = setTimeout(() => {
          if (pc === peerConnection.current && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
            if (restartAttemptsRef.current >= 3) {
              console.warn('Max ICE restart attempts reached. Giving up.');
              return;
            }
            try {
              restartAttemptsRef.current += 1;
              console.log(`Initiating automatic ICE Restart (Attempt ${restartAttemptsRef.current})...`);
              pc.createOffer({ iceRestart: true }).then(offer => {
                pc.setLocalDescription(offer);
                currentSocket.emit('webrtc_offer', { offer, toSocketId: activeSocketIdRef.current });
              });
            } catch (e) {
              console.error('Error during ICE restart:', e);
            }
          }
        }, 5000);
      }
    };

    if (localStreamRef.current) {
      console.log('Adding local tracks to peer connection (initiate)');
      const tracks = localStreamRef.current.getTracks();
      // Sort tracks to ensure consistent m-line order (audio first, then video)
      tracks.sort((a, b) => a.kind.localeCompare(b.kind));
      
      tracks.forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    } else {
      console.warn('No local stream available when initiating call');
    }

    try {
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      // Smart Codec Selection: Ensure VP8 is available as a fallback for older Androids
      if (offer.sdp && !offer.sdp.includes('VP8/90000')) {
        console.warn('VP8 codec not found in SDP. Older devices might fail to decode video.');
      } else {
        console.log('VP8 codec is present in SDP as a fallback.');
      }

      await pc.setLocalDescription(offer);
      currentSocket.emit('webrtc_offer', { offer, toSocketId });
    } catch (e) {
      console.error('Error creating offer:', e);
    }
  }, []);

  const [stats, setStats] = useState<{ bitrate: number; resolution: string }>({ bitrate: 0, resolution: '0x0' });
  const qualityChangeLock = useRef<boolean>(false);
  const pendingQualityPreset = useRef<'auto' | 'high' | 'medium' | 'low' | 'verylow' | null>(null);

  const setVideoQuality = useCallback(async (preset: 'auto' | 'high' | 'medium' | 'low' | 'verylow') => {
    if (!peerConnection.current) return;
    
    // If a change is already in progress, queue the latest request and return
    if (qualityChangeLock.current) {
      console.log('Quality change in progress, queueing:', preset);
      pendingQualityPreset.current = preset;
      return;
    }

    qualityChangeLock.current = true;

    const applyQuality = async (targetPreset: 'auto' | 'high' | 'medium' | 'low' | 'verylow') => {
      if (!peerConnection.current) return;

      const videoSender = peerConnection.current
        .getSenders()
        .find(s => s.track?.kind === 'video' && s.track.readyState === 'live');

      if (!videoSender || !videoSender.track) {
        console.warn('Video sender not found or track not live');
        return;
      }

      const QUALITY_PRESETS = {
        auto:    { maxBitrate: 1500000, scale: 1 }, // Cap at 1.5 Mbps to prevent bufferbloat
        high:    { maxBitrate: 2500000, scale: 1 },
        medium:  { maxBitrate: 1000000, scale: 1.5 },
        low:     { maxBitrate: 400000, scale: 2.5 },
        verylow: { maxBitrate: 150000, scale: 4 }
      };

      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      const target = QUALITY_PRESETS[targetPreset];

      if (target.maxBitrate !== null) {
        params.encodings[0].maxBitrate = target.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = target.scale;
      } else {
        params.encodings[0].maxBitrate = undefined;
        params.encodings[0].scaleResolutionDownBy = 1;
      }

      try {
        await videoSender.setParameters(params);
        console.log(`✅ Video quality changed to ${targetPreset}`);
      } catch (err) {
        console.error('❌ setParameters failed:', err);
      }
    };

    try {
      await applyQuality(preset);
      
      // After applying, check if there's a pending request
      while (pendingQualityPreset.current !== null) {
        const nextPreset = pendingQualityPreset.current;
        pendingQualityPreset.current = null;
        console.log('Applying pending quality change:', nextPreset);
        await applyQuality(nextPreset);
      }
    } finally {
      qualityChangeLock.current = false;
    }
  }, []);

  // Stats monitoring
  useEffect(() => {
    if (!peerConnection.current || connectionState !== 'connected') return;

    let lastBytesSent = 0;
    const interval = setInterval(async () => {
      if (!peerConnection.current || peerConnection.current.connectionState === 'closed') return;
      
      try {
        const statsReport = await peerConnection.current.getStats();
        statsReport.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            const bytesSent = report.bytesSent;
            const bitrate = Math.round(((bytesSent - lastBytesSent) * 8) / 1000); // kbps
            lastBytesSent = bytesSent;
            
            const resolution = `${report.frameWidth || 0}x${report.frameHeight || 0}`;
            setStats({ bitrate, resolution });
          }
        });
      } catch (e) {
        // ignore errors during cleanup
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [connectionState]);

  const cleanup = useCallback(() => {
    console.log('🔥 FULL CLEANUP started');

    if (peerConnection.current) {
      peerConnection.current.getReceivers().forEach(receiver => {
        if (receiver.track) {
          receiver.track.stop();
          receiver.track.enabled = false;
        }
      });
      peerConnection.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
          sender.track.enabled = false;
        }
      });
      peerConnection.current.close();
      peerConnection.current = null;
    }

    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    iceCandidatesQueue.current = [];
    isRemoteDescriptionSet.current = false;
    activeSocketIdRef.current = null;
    isCallerRef.current = false;
    restartAttemptsRef.current = 0;

    setConnectionState('closed');
    setRemoteStreamRef.current(null);
    setSecureEmojis([]);
  }, []);

  return { initiateCall, cleanup, peerConnection, connectionState, setVideoQuality, stats, secureEmojis };
}
