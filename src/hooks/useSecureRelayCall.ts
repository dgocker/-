import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';

const RELAY_TOKEN = 'super-secret-anti-dpi-token-2026';

export function useSecureRelayCall(
  socket: Socket | null,
  activeStreamRef: React.MutableRefObject<MediaStream | null>,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void,
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>,
  setAutoplayFailed: (failed: boolean) => void
) {
  const [connectionState, setConnectionState] = useState<'disconnected' | 'checking' | 'connected'>('disconnected');
  const [stats, setStats] = useState({ rtt: 0, packetLoss: 0, bitrate: 0, resolution: '' });
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const queueRef = useRef<Uint8Array[]>([]);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const isAppendingRef = useRef(false);
  const currentRoomIdRef = useRef<string | null>(null);
  const remoteSupportsWebMRef = useRef<boolean>(true); // Assume true until told otherwise
  
  // Fallback refs
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackIntervalRef = useRef<number | null>(null);
  const remoteImgRef = useRef<HTMLImageElement | null>(null);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (fallbackIntervalRef.current) {
      window.clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }
    if (fallbackVideoRef.current) {
      fallbackVideoRef.current.srcObject = null;
    }
    if (remoteImgRef.current) {
      remoteImgRef.current.remove();
      remoteImgRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.style.display = 'block';
    }
    setConnectionState('disconnected');
    queueRef.current = [];
    currentRoomIdRef.current = null;
    remoteSupportsWebMRef.current = true;
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
    if (fallbackIntervalRef.current) {
      window.clearInterval(fallbackIntervalRef.current);
    }

    if (activeStreamRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      const isMediaRecorderSupported = typeof MediaRecorder !== 'undefined';
      let mimeType = 'video/webm; codecs="vp8, opus"';
      let canUseMediaRecorder = false;

      if (isMediaRecorderSupported && remoteSupportsWebMRef.current) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          canUseMediaRecorder = true;
        } else if (MediaRecorder.isTypeSupported('video/webm')) {
          mimeType = 'video/webm';
          canUseMediaRecorder = true;
        }
      }

      if (canUseMediaRecorder) {
        try {
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
          return;
        } catch (e) {
          console.error('Failed to start MediaRecorder, falling back to JPEG', e);
        }
      }

      // Fallback to JPEG frames (Motion JPEG)
      if (!fallbackCanvasRef.current) {
        fallbackCanvasRef.current = document.createElement('canvas');
      }
      if (!fallbackVideoRef.current) {
        fallbackVideoRef.current = document.createElement('video');
        fallbackVideoRef.current.muted = true;
        fallbackVideoRef.current.playsInline = true;
      }
      
      const canvas = fallbackCanvasRef.current;
      const ctx = canvas.getContext('2d');
      const video = fallbackVideoRef.current;
      
      if (video.srcObject !== activeStreamRef.current) {
        video.srcObject = activeStreamRef.current;
        video.play().catch(e => console.error('Fallback video play error', e));
      }

      fallbackIntervalRef.current = window.setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN && video.videoWidth > 0) {
          // Downscale slightly for better performance over WebSocket
          const scale = 0.5;
          canvas.width = video.videoWidth * scale;
          canvas.height = video.videoHeight * scale;
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.4);
          wsRef.current.send(dataUrl);
        }
      }, 100); // 10 fps
    }
  };

  const setRemoteSupportsWebM = (supports: boolean) => {
    remoteSupportsWebMRef.current = supports;
    console.log('Remote supports WebM:', supports);
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

    const isMediaSourceSupported = typeof window.MediaSource !== 'undefined';
    let isMediaSourceFailed = false;
    
    if (isMediaSourceSupported) {
      try {
        const mediaSource = new MediaSource();
        if (remoteVideoRef.current) {
          remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
          remoteVideoRef.current.play()
            .then(() => setAutoplayFailed(false))
            .catch(e => {
              console.error('Play failed', e);
              if (e.name !== 'AbortError') {
                setAutoplayFailed(true);
              }
            });
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
            
            // Process any queued chunks that arrived before sourceopen
            processQueue();
          } catch (e) {
            console.error('SourceBuffer error', e);
            isMediaSourceFailed = true;
            queueRef.current = []; // Clear queue to avoid memory leak
          }
        });
      } catch (e) {
        console.error('MediaSource initialization failed', e);
        isMediaSourceFailed = true;
      }
    } else {
      isMediaSourceFailed = true;
    }

    ws.onmessage = (event) => {
      if (typeof event.data === 'string' && event.data.startsWith('data:image/jpeg')) {
        // Handle JPEG fallback frame
        if (remoteVideoRef.current) {
          remoteVideoRef.current.style.display = 'none'; // Hide video element
          
          if (!remoteImgRef.current) {
            remoteImgRef.current = document.createElement('img');
            remoteImgRef.current.className = remoteVideoRef.current.className;
            remoteImgRef.current.style.display = 'block';
            remoteVideoRef.current.parentElement?.appendChild(remoteImgRef.current);
          }
          remoteImgRef.current.src = event.data;
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Handle WebM padded buffer
        if (!isMediaSourceFailed) {
          const unpaddedData = removePadding(event.data);
          queueRef.current.push(new Uint8Array(unpaddedData));
          if (sourceBufferRef.current) {
            processQueue();
          }
        }
      }
    };

    ws.onclose = () => {
      cleanup();
      onCallEnded();
    };
  };

  // Compatibility with Dashboard.tsx
  const initiateCall = (targetSocketId: string) => {
    startRecording();
  };

  const setVideoQuality = (quality: string) => {
    console.log('Quality adjustment not supported in Relay mode yet');
  };

  const joinRoom = (roomId: string) => {
    connectToRelay(roomId);
  };

  return {
    initiateCall,
    cleanup,
    peerConnection: { current: null },
    connectionState,
    setVideoQuality,
    stats,
    secureEmojis: ['🔒', '🛡️', '📡'],
    joinRoom,
    startRecording,
    setRemoteSupportsWebM
  };
}
