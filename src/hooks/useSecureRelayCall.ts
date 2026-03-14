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
  const [remoteJpeg, setRemoteJpeg] = useState<string | null>(null);
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
  const pingIntervalRef = useRef<number | null>(null);
  const lastAudioLogTimeRef = useRef<number>(0);
  const audioChunkCountRef = useRef<number>(0);
  const firstJpegReceivedRef = useRef<boolean>(false);

  const startPing = (ws: WebSocket) => {
    if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
    pingIntervalRef.current = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }, 5000);
  };

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
      fallbackVideoRef.current.remove();
      fallbackVideoRef.current = null;
    }
    if (fallbackCanvasRef.current) {
      fallbackCanvasRef.current.remove();
      fallbackCanvasRef.current = null;
    }
    if (remoteImgRef.current) {
      remoteImgRef.current.remove();
      remoteImgRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.style.display = 'block';
      remoteVideoRef.current.style.opacity = '0.01';
      remoteVideoRef.current.style.position = 'absolute';
      remoteVideoRef.current.style.width = '1px';
      remoteVideoRef.current.style.height = '1px';
      remoteVideoRef.current.style.pointerEvents = 'none';
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    setConnectionState('disconnected');
    queueRef.current = [];
    currentRoomIdRef.current = null;
    remoteSupportsWebMRef.current = true;
    audioHeaderRef.current = null;
    firstJpegReceivedRef.current = false;
    setRemoteJpeg(null);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.src = '';
    }
  }, [remoteVideoRef, addLog]);

  const addPadding = (originalBuffer: ArrayBuffer, type: number = 0) => {
    const originalView = new Uint8Array(originalBuffer);
    const originalSize = originalView.length;
    const paddingSize = Math.floor(Math.random() * 4500) + 500; 
    const totalSize = 5 + originalSize + paddingSize; // 1 byte for type + 4 bytes for size
    const paddedBuffer = new ArrayBuffer(totalSize);
    const paddedView = new DataView(paddedBuffer);
    const paddedUint8 = new Uint8Array(paddedBuffer);
    
    paddedUint8[0] = type; // 0 = WebM, 1 = MP4
    paddedView.setUint32(1, originalSize, true);
    paddedUint8.set(originalView, 5);
    
    for (let i = 5 + originalSize; i < totalSize; i++) {
      paddedUint8[i] = Math.floor(Math.random() * 256);
    }
    return paddedBuffer;
  };

  const removePadding = (paddedBuffer: ArrayBuffer) => {
    const paddedView = new DataView(paddedBuffer);
    const type = new Uint8Array(paddedBuffer)[0];
    const originalSize = paddedView.getUint32(1, true);
    return { 
      data: paddedBuffer.slice(5, 5 + originalSize),
      type
    };
  };

  const processQueue = () => {
    if (!sourceBufferRef.current || isAppendingRef.current || queueRef.current.length === 0) return;
    
    if (queueRef.current.length > 30) {
      addLog(`⚠️ Queue getting large: ${queueRef.current.length} chunks`);
    }

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
        addLog('🎙️ AudioContext initialized');
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
        addLog('🎙️ AudioContext resumed');
      }

      // If we don't have a header, this might be it (first chunk)
      // WebM headers are usually > 100 bytes, MP4 headers can be larger
      if (!audioHeaderRef.current || audioHeaderRef.current.length < 10) {
        audioHeaderRef.current = new Uint8Array(chunk);
        addLog(`🎙️ Saved audio header (${chunk.byteLength} bytes)`);
        return;
      }

      // Prepend header to chunk to make it decodable as a standalone piece
      const fullData = new Uint8Array(audioHeaderRef.current.length + chunk.byteLength);
      fullData.set(audioHeaderRef.current);
      fullData.set(new Uint8Array(chunk), audioHeaderRef.current.length);

      // decodeAudioData can fail on fragmented MP4, but we try anyway as last resort
      ctx.decodeAudioData(fullData.buffer, (buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        
        audioChunkCountRef.current++;
        const now = Date.now();
        if (now - lastAudioLogTimeRef.current > 10000) { // Log every 10 seconds
          addLog(`🔊 Audio playback active: ${audioChunkCountRef.current} chunks decoded`);
          lastAudioLogTimeRef.current = now;
        }
      }, (err) => {
        // Silent fail for small chunks that can't be decoded
        const now = Date.now();
        if (now - lastAudioLogTimeRef.current > 30000) {
          addLog(`⚠️ Audio decoding failed for a chunk: ${err}. Header size: ${audioHeaderRef.current?.length}`);
          lastAudioLogTimeRef.current = now;
        }
      });
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
          addLog(`🎥 Starting full WebM recording: ${mimeType}`);
          const recorder = new MediaRecorder(activeStreamRef.current, { 
            mimeType,
            videoBitsPerSecond: 250000, // 250kbps for stability
            audioBitsPerSecond: 64000
          });
          mediaRecorderRef.current = recorder;
          
          recorder.onstart = () => addLog('🎥 MediaRecorder started');
          recorder.onerror = (e) => addLog(`❌ MediaRecorder error: ${(e as any).error?.message || e.type}`);
          
          recorder.ondataavailable = async (event) => {
            if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
              try {
                const buffer = await event.data.arrayBuffer();
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(addPadding(buffer, 0)); // 0 = WebM
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
      fallbackVideoRef.current.style.display = 'none';
      document.body.appendChild(fallbackVideoRef.current);
    }
    
    if (!fallbackCanvasRef.current) {
      fallbackCanvasRef.current = document.createElement('canvas');
      fallbackCanvasRef.current.style.display = 'none';
      document.body.appendChild(fallbackCanvasRef.current);
    }
    
    const canvas = fallbackCanvasRef.current;
    const ctx = canvas.getContext('2d', { alpha: false });
    const video = fallbackVideoRef.current;
    
    let framesSent = 0;
    
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
              framesSent++;
              if (framesSent === 1) {
                addLog('📸 First JPEG frame sent');
              }
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
      
      // If remote doesn't support WebM (likely iOS), we MUST use MP4/AAC for them to hear us
      // Also force MP4 if WE are on iOS to improve our own recording stability
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if ((!remoteSupportsWebMRef.current || isIOS) && MediaRecorder.isTypeSupported('audio/mp4')) {
        audioMimeType = 'audio/mp4';
        addLog(`🎙️ iOS detected or remote lacks WebM, forcing audio/mp4 for compatibility: ${audioMimeType}`);
      } else {
        if (!MediaRecorder.isTypeSupported(audioMimeType)) {
          audioMimeType = 'audio/webm';
        }
        if (!MediaRecorder.isTypeSupported(audioMimeType)) {
          audioMimeType = 'audio/mp4'; // iOS fallback
        }
      }

      addLog(`🎙️ Starting audio recording with mimeType: ${audioMimeType}`);
      const audioStream = new MediaStream(audioTracks);
      const audioRecorder = new MediaRecorder(audioStream, { 
        mimeType: audioMimeType,
        audioBitsPerSecond: 32000 // Low bitrate for stability
      });
      audioRecorderRef.current = audioRecorder;
      
      audioRecorder.onstart = () => addLog('🎙️ Audio fallback recorder started');
      audioRecorder.onerror = (e) => addLog(`❌ Audio recorder error: ${(e as any).error?.message || e.type}`);
      
      const typeByte = audioMimeType.includes('mp4') ? 1 : 0;
      
      audioRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          try {
            const buffer = await event.data.arrayBuffer();
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(addPadding(buffer, typeByte));
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
      startPing(ws);
    };

    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      addLog(`❌ WebSocket error (State: ${ws.readyState})`);
    };

    const isMediaSourceSupported = typeof window.MediaSource !== 'undefined' || typeof (window as any).ManagedMediaSource !== 'undefined';
    let isMediaSourceFailed = false;
    
    addLog(`ℹ️ MediaSource support: ${isMediaSourceSupported ? (window.MediaSource ? 'Standard' : 'Managed') : 'None'}`);
    
    if (isMediaSourceSupported) {
      try {
        const MediaSourceClass = window.MediaSource || (window as any).ManagedMediaSource;
        const mediaSource = new MediaSourceClass();
        
        mediaSource.addEventListener('sourceclose', () => addLog('ℹ️ MediaSource closed'));
        mediaSource.addEventListener('sourceended', () => addLog('ℹ️ MediaSource ended'));

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
            const isFallbackMode = !remoteSupportsWebMRef.current || !mySupportsWebMRef.current;
            let mimeType = 'video/webm; codecs="vp8, opus"';
            
            if (isFallbackMode) {
              // If we are in fallback mode, we are likely receiving MP4 from iOS or to iOS
              // Check what the remote supports to guess what they are sending
              if (!mySupportsWebMRef.current) {
                mimeType = 'audio/mp4';
              } else {
                mimeType = 'audio/webm; codecs=opus';
              }
              addLog(`🎙️ Initializing SourceBuffer for audio-only: ${mimeType}`);
            } else {
              if (!MediaSourceClass.isTypeSupported(mimeType)) mimeType = 'video/webm';
              addLog(`🎥 Initializing SourceBuffer for video+audio: ${mimeType}`);
            }

            if (!MediaSourceClass.isTypeSupported(mimeType)) {
              addLog(`⚠️ MimeType ${mimeType} not supported by MediaSource, trying fallback...`);
              if (mimeType.includes('webm')) mimeType = 'audio/webm';
              else mimeType = 'audio/mp4';
            }

            const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBufferRef.current = sourceBuffer;
            addLog(`✅ SourceBuffer created (${mimeType})`);
            
            sourceBuffer.addEventListener('error', (e) => addLog(`❌ SourceBuffer error event: ${e}`));
            sourceBuffer.addEventListener('abort', () => addLog('⚠️ SourceBuffer abort event'));

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
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            const rtt = Date.now() - msg.ts;
            setStats(prev => ({ ...prev, rtt }));
            return;
          }
        } catch (e) {}

        if (event.data.startsWith('data:image/jpeg')) {
          setRemoteJpeg(event.data);
          if (!firstJpegReceivedRef.current) {
            firstJpegReceivedRef.current = true;
            addLog('📸 Received first JPEG frame from remote');
          }
          if (remoteVideoRef.current && remoteVideoRef.current.style.opacity !== '0.01') {
            remoteVideoRef.current.style.opacity = '0.01';
            remoteVideoRef.current.style.position = 'absolute';
            remoteVideoRef.current.style.width = '1px';
            remoteVideoRef.current.style.height = '1px';
            addLog('ℹ️ Switched to JPEG fallback display (keeping video for audio)');
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Handle padded buffer
        const { data: unpaddedData, type } = removePadding(event.data);
        
        // If we are in fallback mode or the type is MP4, we might need special handling
        const isFallbackMode = !remoteSupportsWebMRef.current || !mySupportsWebMRef.current;
        
        if (!isMediaSourceFailed && sourceBufferRef.current) {
          queueRef.current.push(new Uint8Array(unpaddedData));
          processQueue();
        } else {
          // Audio playback fallback
          if (type === 0) {
            playAudioChunk(unpaddedData);
          } else if (type === 1) {
            if (audioChunkCountRef.current === 0) {
              addLog('🎙️ Receiving MP4 audio chunks (fallback)');
            }
            playAudioChunk(unpaddedData);
          }
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
    remoteJpeg,
    resumeAudio: async () => {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        addLog('🎙️ AudioContext initialized via manual action');
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        await ctx.resume();
        addLog('🎙️ AudioContext resumed via manual action');
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.play().catch(() => {});
      }
    }
  };
}
