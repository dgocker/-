import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Socket } from 'socket.io-client';

const RELAY_TOKEN = 'super-secret-anti-dpi-token-2026';

export function useSecureRelayCall(
  socket: Socket | null,
  activeStreamRef: React.MutableRefObject<MediaStream | null>,
  setRemoteStream: (stream: MediaStream | null) => void,
  onCallEnded: () => void,
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>,
  setAutoplayFailed: (failed: boolean) => void,
  addLog: (msg: string) => void
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
  const mySupportsWebMRef = useRef<boolean>(false);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  
  // Fallback refs
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const fallbackIntervalRef = useRef<number | null>(null);
  const remoteImgRef = useRef<HTMLImageElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioHeaderRef = useRef<Uint8Array | null>(null);

  const cleanup = useCallback(() => {
    addLog('🧹 Cleaning up call resources...');
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
    }
    if (audioRecorderRef.current && audioRecorderRef.current.state !== 'inactive') {
      try { audioRecorderRef.current.stop(); } catch (e) {}
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
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setConnectionState('disconnected');
    queueRef.current = [];
    currentRoomIdRef.current = null;
    remoteSupportsWebMRef.current = true;
    audioHeaderRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = '';
    }
  }, [remoteVideoRef, addLog]);

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
      addLog(`❌ Error appending buffer: ${e}`);
      isAppendingRef.current = false;
    }
  };

  const playAudioChunk = async (chunk: ArrayBuffer) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      // If we don't have a header, this might be it (first chunk)
      if (!audioHeaderRef.current) {
        audioHeaderRef.current = new Uint8Array(chunk);
        return;
      }

      // Prepend header to chunk to make it decodable as a standalone piece
      const fullData = new Uint8Array(audioHeaderRef.current.length + chunk.byteLength);
      fullData.set(audioHeaderRef.current);
      fullData.set(new Uint8Array(chunk), audioHeaderRef.current.length);

      const audioBuffer = await ctx.decodeAudioData(fullData.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (e) {
      // decodeAudioData often fails on partial chunks, this is expected
    }
  };

  const startRecording = () => {
    addLog('🎥 Starting media recording...');
    
    // Stop any existing recording or fallback
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
    }
    if (audioRecorderRef.current && audioRecorderRef.current.state !== 'inactive') {
      try { audioRecorderRef.current.stop(); } catch (e) {}
    }
    if (fallbackIntervalRef.current) {
      window.clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }

    if (activeStreamRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      const isMediaRecorderSupported = typeof MediaRecorder !== 'undefined';
      let mimeType = 'video/webm; codecs="vp8, opus"';
      let canUseFullWebM = false;

      // We can only use full WebM if BOTH sides support it
      if (isMediaRecorderSupported && remoteSupportsWebMRef.current && mySupportsWebMRef.current) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          canUseFullWebM = true;
        } else if (MediaRecorder.isTypeSupported('video/webm')) {
          mimeType = 'video/webm';
          canUseFullWebM = true;
        }
      }

      if (canUseFullWebM) {
        try {
          addLog(`✅ Using MediaRecorder with mimeType: ${mimeType}`);
          const recorder = new MediaRecorder(activeStreamRef.current, { 
            mimeType,
            videoBitsPerSecond: 250000 // 250kbps for stability
          });
          mediaRecorderRef.current = recorder;
          recorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
              try {
                const buffer = await event.data.arrayBuffer();
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(addPadding(buffer));
                }
              } catch (e) {
                console.error('Error sending media chunk:', e);
              }
            }
          };
          recorder.start(200);
          return;
        } catch (e) {
          console.error('Failed to start MediaRecorder, falling back to JPEG', e);
          addLog(`⚠️ MediaRecorder failed: ${e}. Falling back to JPEG.`);
        }
      } else {
        addLog('⚠️ Using JPEG + Audio fallback (WebM not supported by both sides).');
      }

      // Fallback to JPEG frames (Motion JPEG) + Audio-only WebM
      startFallbackRecording();
    } else {
      addLog('⚠️ Cannot start recording: stream or websocket not ready');
    }
  };

  const startFallbackRecording = () => {
    if (!activeStreamRef.current) return;

    // 1. Video Fallback (JPEG)
    if (!fallbackCanvasRef.current) {
      fallbackCanvasRef.current = document.createElement('canvas');
    }
    if (!fallbackVideoRef.current) {
      fallbackVideoRef.current = document.createElement('video');
      fallbackVideoRef.current.muted = true;
      fallbackVideoRef.current.playsInline = true;
    }
    
    const canvas = fallbackCanvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const video = fallbackVideoRef.current;
    
    if (video.srcObject !== activeStreamRef.current) {
      video.srcObject = activeStreamRef.current;
      video.play().catch(e => {
        console.error('Fallback video play error', e);
        addLog(`❌ Fallback video play error: ${e}`);
      });
    }

    // Lower frequency and quality for stability
    fallbackIntervalRef.current = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN && video.videoWidth > 0) {
        // Downscale for better performance over WebSocket
        const scale = 0.4; 
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;
        
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'low';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // Use lower quality for JPEG to reduce payload size
          const dataUrl = canvas.toDataURL('image/jpeg', 0.3);
          
          if (wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(dataUrl);
            } catch (e) {
              console.error('Error sending JPEG frame:', e);
            }
          }
        }
      }
    }, 150); // ~6.6 fps

    // 2. Audio Fallback (Audio-only WebM)
    try {
      const audioTracks = activeStreamRef.current.getAudioTracks();
      if (audioTracks.length === 0) {
        addLog('⚠️ No audio tracks found for fallback recording');
        return;
      }
      
      addLog(`🎙️ Found ${audioTracks.length} audio tracks for fallback`);

      let audioMimeType = 'audio/webm; codecs=opus';
      if (!MediaRecorder.isTypeSupported(audioMimeType)) {
        audioMimeType = 'audio/webm';
      }
      if (!MediaRecorder.isTypeSupported(audioMimeType)) {
        audioMimeType = 'audio/mp4'; // iOS fallback
      }

      addLog(`🎙️ Starting audio recording with mimeType: ${audioMimeType}`);
      const audioStream = new MediaStream(audioTracks);
      const audioRecorder = new MediaRecorder(audioStream, { 
        mimeType: audioMimeType,
        audioBitsPerSecond: 32000 // Low bitrate for stability
      });
      audioRecorderRef.current = audioRecorder;
      audioRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            const buffer = await event.data.arrayBuffer();
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(addPadding(buffer));
            }
          } catch (e) {}
        }
      };
      audioRecorder.start(200);
    } catch (e) {
      addLog(`❌ Audio recording failed: ${e}`);
    }
  };

  const setRemoteSupportsWebM = (supports: boolean) => {
    const changed = remoteSupportsWebMRef.current !== supports;
    remoteSupportsWebMRef.current = supports;
    console.log('Remote supports WebM:', supports);
    addLog(`ℹ️ Remote supports WebM: ${supports}`);
    
    if (changed && connectionState === 'connected') {
      addLog('🚀 Remote WebM support changed, restarting recording...');
      startRecording();
    }
  };

  const [secureEmojis, setSecureEmojis] = useState<string[]>(['🔒', '🛡️', '📡', '✨']);

  const generateEmojis = (seed: string) => {
    const emojiList = [
      '🍎', '🦊', '🚀', '💎', '🌈', '🌙', '🍀', '🔥', 
      '🧊', '⚡', '🦄', '🎈', '🎨', '🎭', '🎸', '🏆',
      '🛸', '🪐', '🍄', '🌵', '🌸', '🐳', '🦜', '🦁'
    ];
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    
    const result = [];
    for (let i = 0; i < 4; i++) {
      const index = Math.abs((hash + i * 7) % emojiList.length);
      result.push(emojiList[index]);
    }
    setSecureEmojis(result);
  };

  const connectToRelay = (roomId: string) => {
    currentRoomIdRef.current = roomId;
    generateEmojis(roomId);
    setConnectionState('checking');
    addLog(`🔗 Connecting to Secure Relay room: ${roomId}`);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/secure-relay?room=${roomId}&token=${RELAY_TOKEN}`;
    
    addLog(`📡 WebSocket URL: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to Secure Relay');
      addLog('✅ WebSocket connected to Relay');
      setConnectionState('connected');
      setRemoteStream(new MediaStream()); // Trick Dashboard into thinking we have a stream
      startRecording();
    };

    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      addLog(`❌ WebSocket error (State: ${ws.readyState})`);
    };

    const isMediaSourceSupported = typeof window.MediaSource !== 'undefined' || typeof (window as any).ManagedMediaSource !== 'undefined';
    let isMediaSourceFailed = false;
    
    addLog(`ℹ️ MediaSource supported: ${isMediaSourceSupported}`);
    
    if (isMediaSourceSupported) {
      try {
        const MediaSourceClass = window.MediaSource || (window as any).ManagedMediaSource;
        const mediaSource = new MediaSourceClass();
        if (remoteVideoRef.current) {
          remoteVideoRef.current.src = URL.createObjectURL(mediaSource);
          remoteVideoRef.current.play()
            .then(() => {
              setAutoplayFailed(false);
              addLog('✅ Remote video playback started');
            })
            .catch(e => {
              console.error('Play failed', e);
              addLog(`⚠️ Remote video play failed: ${e.name}`);
              if (e.name !== 'AbortError') {
                setAutoplayFailed(true);
              }
            });
        }

        mediaSource.addEventListener('sourceopen', () => {
          addLog('ℹ️ MediaSource sourceopen event');
          try {
            // If EITHER side doesn't support WebM, we are in JPEG+Audio mode
            // So we should expect audio-only WebM chunks
            let mimeType = 'video/webm; codecs="vp8, opus"';
            const isFallbackMode = !remoteSupportsWebMRef.current || !mySupportsWebMRef.current;
            
            if (isFallbackMode) {
              // Try different audio mime types for compatibility
              const audioTypes = ['audio/webm; codecs=opus', 'audio/webm', 'audio/mp4'];
              mimeType = audioTypes.find(t => MediaSourceClass.isTypeSupported(t)) || 'audio/webm';
              addLog(`🎙️ Initializing SourceBuffer for audio-only: ${mimeType}`);
            } else {
              if (!MediaSourceClass.isTypeSupported(mimeType)) mimeType = 'video/webm';
              addLog(`🎥 Initializing SourceBuffer for video+audio: ${mimeType}`);
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
            addLog(`❌ SourceBuffer error: ${e}`);
            isMediaSourceFailed = true;
          }
        });
      } catch (e) {
        console.error('MediaSource initialization failed', e);
        addLog(`❌ MediaSource init failed: ${e}`);
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
            remoteImgRef.current.style.width = '100%';
            remoteImgRef.current.style.height = '100%';
            remoteImgRef.current.style.objectFit = 'cover';
            remoteVideoRef.current.parentElement?.appendChild(remoteImgRef.current);
            addLog('ℹ️ Switched to JPEG fallback display');
          }
          remoteImgRef.current.src = event.data;
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Handle WebM padded buffer
        const unpaddedData = removePadding(event.data);
        
        if (!isMediaSourceFailed) {
          queueRef.current.push(new Uint8Array(unpaddedData));
          if (sourceBufferRef.current) {
            processQueue();
          }
        } else {
          // Fallback audio playback for devices without MSE
          playAudioChunk(unpaddedData);
        }
      }
    };

    ws.onclose = (e) => {
      addLog(`🔌 WebSocket closed: ${e.code} ${e.reason}`);
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

  const joinRoom = (roomId: string, supportsWebM?: boolean) => {
    if (supportsWebM !== undefined) {
      mySupportsWebMRef.current = supportsWebM;
    }
    connectToRelay(roomId);
  };

  return {
    initiateCall,
    cleanup,
    peerConnection: { current: null },
    connectionState,
    setVideoQuality,
    stats,
    secureEmojis,
    joinRoom,
    startRecording,
    setRemoteSupportsWebM,
    resumeAudio: async () => {
      if (audioContextRef.current) {
        await audioContextRef.current.resume();
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.play().catch(() => {});
      }
    }
  };
}
