import { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';

const RELAY_TOKEN = 'super-secret-anti-dpi-token-2026';

export function useSecureRelayCall(
  socket: Socket | null,
  activeStreamRef: React.MutableRefObject<MediaStream | null>,
  setRemoteStream: (stream: MediaStream | null) => void, // Kept for compatibility, though we use MediaSource directly
  onCallEnded: () => void,
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>
) {
  const [connectionState, setConnectionState] = useState<'disconnected' | 'checking' | 'connected'>('disconnected');
  const [stats, setStats] = useState({ rtt: 0, packetLoss: 0, bitrate: 0, resolution: '' });
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const queueRef = useRef<Uint8Array[]>([]);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const isAppendingRef = useRef(false);
  const currentRoomIdRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setConnectionState('disconnected');
    queueRef.current = [];
    currentRoomIdRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = '';
    }
  }, [remoteVideoRef]);

  const addPadding = (originalBuffer: ArrayBuffer) => {
    const originalView = new Uint8Array(originalBuffer);
    const originalSize = originalView.length;
    const paddingSize = Math.floor(Math.random() * 4500) + 500; 
    const totalSize = 4 + originalSize + paddingSize;
    const paddedBuffer = new ArrayBuffer(totalSize);
    const paddedView = new DataView(paddedBuffer);
    const paddedUint8 = new Uint8Array(paddedBuffer);
    paddedView.setUint32(0, originalSize, true);
    paddedUint8.set(originalView, 4);
    for (let i = 4 + originalSize; i < totalSize; i++) {
      paddedUint8[i] = Math.floor(Math.random() * 256);
    }
    return paddedBuffer;
  };

  const removePadding = (paddedBuffer: ArrayBuffer) => {
    const paddedView = new DataView(paddedBuffer);
    const originalSize = paddedView.getUint32(0, true);
    return paddedBuffer.slice(4, 4 + originalSize);
  };

  const processQueue = () => {
    if (!sourceBufferRef.current || isAppendingRef.current || queueRef.current.length === 0) return;
    try {
      if (!sourceBufferRef.current.updating) {
        isAppendingRef.current = true;
        const data = queueRef.current.shift();
        if (data) sourceBufferRef.current.appendBuffer(data);
      }
    } catch (e) {
      console.error('Error appending buffer', e);
      isAppendingRef.current = false;
    }
  };

  const startRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (activeStreamRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        let mimeType = 'video/webm; codecs="vp8, opus"';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm';
        }
        const recorder = new MediaRecorder(activeStreamRef.current, { mimeType });
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = async (event) => {
          if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            const buffer = await event.data.arrayBuffer();
            const paddedData = addPadding(buffer);
            wsRef.current.send(paddedData);
          }
        };
        recorder.start(200);
      } catch (e) {
        console.error('Failed to start MediaRecorder', e);
      }
    }
  };

  const connectToRelay = (roomId: string) => {
    currentRoomIdRef.current = roomId;
    setConnectionState('checking');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/secure-relay?room=${roomId}&token=${RELAY_TOKEN}`;
    
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to Secure Relay');
      setConnectionState('connected');
      setRemoteStream(new MediaStream()); // Trick Dashboard into thinking we have a stream
      startRecording();
    };

    const mediaSource = new MediaSource();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
      remoteVideoRef.current.play().catch(e => console.error('Play failed', e));
    }

    mediaSource.addEventListener('sourceopen', () => {
      try {
        let mimeType = 'video/webm; codecs="vp8, opus"';
        if (!MediaSource.isTypeSupported(mimeType)) {
          mimeType = 'video/webm';
        }
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBufferRef.current = sourceBuffer;
        
        sourceBuffer.addEventListener('updateend', () => {
          isAppendingRef.current = false;
          processQueue();
        });

        ws.onmessage = (event) => {
          const unpaddedData = removePadding(event.data);
          queueRef.current.push(new Uint8Array(unpaddedData));
          processQueue();
        };
      } catch (e) {
        console.error('SourceBuffer error', e);
      }
    });

    ws.onclose = () => {
      cleanup();
      onCallEnded();
    };
  };

  // Compatibility with Dashboard.tsx
  const initiateCall = (targetSocketId: string) => {
    // In relay mode, the caller already connected to the room when they clicked "Call".
    // We don't need to do WebRTC signaling here.
    // But we can start recording if we haven't already.
    startRecording();
  };

  const setVideoQuality = (quality: string) => {
    console.log('Quality adjustment not supported in Relay mode yet');
  };

  // Expose a way to connect to a room
  const joinRoom = (roomId: string) => {
    connectToRelay(roomId);
  };

  return {
    initiateCall,
    cleanup,
    peerConnection: { current: null }, // Dummy to prevent crashes
    connectionState,
    setVideoQuality,
    stats,
    secureEmojis: ['🔒', '🛡️', '📡'],
    joinRoom,
    startRecording
  };
}
