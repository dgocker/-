export interface VideoPacket {
  frameId: number;
  receiveTime: number;
  senderTs: number; 
  raw: Uint8Array;
  type: 'key' | 'delta';
}

export class H264Decoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private decoder: VideoDecoder | null = null;
  private jitterBuffer: VideoPacket[] = [];
  private targetDelay = 2000; // Fixed large value to handle RTT spikes

  private isPlaying = false;
  private onLog?: (msg: string) => void;
  private isConfigured = false;
  private rotation: number = 0; 
  private mirror: boolean = false;
  private flip: boolean = false; 
  
  private currentRtt: number = 0;
  private estimatedOneWay: number = 0;
  private rttHistory: number[] = [];
  private lastRttSmoothed: number = 0;
  
  // Adaptive Jitter Buffer (Task 18 & Jitter Fix)
  private readonly MAX_DELAY = 10000; 
  private readonly MIN_DELAY = 100;
  private readonly CATCH_UP_THRESHOLD = 2000;

  private firstSenderTs = -1;
  private firstPlayoutTime = -1;
  private lastBufferEmptyTime = 0;
  
  // Statistical Jitter tracking (Task 17)
  private jitterLog: number[] = [];
  private lastReceiveTime = 0;
  private lastSenderTs = 0;

  constructor(canvas: HTMLCanvasElement, onLog?: (msg: string) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.onLog = onLog;
    this.initDecoder();
  }

  private initDecoder() {
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          let angle = this.rotation;
          
          // Attempt 9: Always Vertical Fix
          if (angle === 0 && frame.displayWidth > frame.displayHeight) {
            angle = 90;
          }

          const isRotated = angle === 90 || angle === 270;
          const displayW = isRotated ? frame.displayHeight : frame.displayWidth;
          const displayH = isRotated ? frame.displayWidth : frame.displayHeight;

          if (this.canvas.width !== displayW || this.canvas.height !== displayH) {
            this.canvas.width = displayW;
            this.canvas.height = displayH;
          }

          this.ctx.save();
          this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
          this.ctx.rotate((angle * Math.PI) / 180);
          if (this.mirror || this.flip) {
            this.ctx.scale(this.mirror ? -1 : 1, this.flip ? -1 : 1);
          }
          this.ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2);
          this.ctx.restore();
          frame.close();
        },
        error: (e) => {
          if (this.onLog) this.onLog(`\u274C Decoder: ${e.message}`);
        }
      });
    } catch (e) { }
  }

  private configure() {
    if (!this.decoder) return;
    try {
      this.decoder.configure({
        codec: "avc1.42e01f", // Attempt 4: Baseline Profile
        optimizeForLatency: true
      });
      this.isConfigured = true;
    } catch (e) { }
  }

  private isKeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i < Math.min(data.length - 4, 100); i++) {
        if (data[i] === 0 && data[i+1] === 0) {
            let offset = 0;
            if (data[i+2] === 1) offset = 3;
            else if (data[i+2] === 0 && data[i+3] === 1) offset = 4;
            if (offset > 0) {
                const nalType = data[i + offset] & 0x1F;
                if (nalType === 5 || nalType === 7 || nalType === 8) return true;
            }
        }
    }
    return false;
  }

  public pushPacket(binary: Uint8Array, frameId: number, fps: number, senderTs: number) {
    if (!this.decoder) return;
    if (!this.isConfigured) this.configure();

    const now = performance.now();
    const type = this.isKeyFrame(binary) ? 'key' : 'delta';

    // Adaptive Jitter Logic (Jitter = variance in arrival time)
    if (this.lastSenderTs > 0) {
      const expectedArrive = this.lastReceiveTime + (senderTs - this.lastSenderTs);
      const jitter = Math.max(0, now - expectedArrive);
      this.jitterLog.push(jitter);
      if (this.jitterLog.length > 100) this.jitterLog.shift();
      
      if (this.jitterLog.length >= 10 && this.jitterLog.length % 10 === 0) {
        const sorted = [...this.jitterLog].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        
        // Attempt 10: Smooth Target Delay (0.9 old + 0.1 new)
        const newTarget = Math.min(800, Math.max(this.MIN_DELAY, this.estimatedOneWay + 40 + (p95 * 1.3)));
        this.targetDelay = this.targetDelay * 0.9 + newTarget * 0.1;
        
        if (this.onLog && Math.abs(newTarget - this.targetDelay) > 100) {
          this.onLog(`📊 Smoothing targetDelay to ${Math.round(this.targetDelay)}ms (p95=${Math.round(p95)}ms, RTT=${Math.round(this.currentRtt)}ms)`);
        }
      }
    }

    this.lastReceiveTime = now;
    this.lastSenderTs = senderTs;

    const packet: VideoPacket = { frameId, receiveTime: now, senderTs, raw: binary, type };
    this.jitterBuffer.push(packet);
    this.jitterBuffer.sort((a, b) => a.frameId - b.frameId);

    // Attempt 8/9: Fast Recovery (Instant Unfreeze)
    // If the jitter buffer exceeds 1s of video, skip to the latest keyframe.
    if (this.jitterBuffer.length > 0) {
      const bufferDuration = this.jitterBuffer[this.jitterBuffer.length - 1].senderTs - this.jitterBuffer[0].senderTs;
      if (bufferDuration > 1000) {
        const lastKeyIdx = this.jitterBuffer.map(p => p.type).lastIndexOf('key');
        if (lastKeyIdx > 0) {
          if (this.onLog) this.onLog(`⏭️ Fast Recovery: Buffer duration ${Math.round(bufferDuration)}ms > 1000ms, skipping to latest keyframe`);
          this.jitterBuffer = this.jitterBuffer.slice(lastKeyIdx);
          this.firstSenderTs = -1; // Reset sync
        }
      }
    }

    if (!this.isPlaying && this.jitterBuffer.length >= 1) { // Trigger immediately if any frame
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`▶️ Starting playback, buffer: ${this.jitterBuffer.length}`);
      requestAnimationFrame(this.playNext);
    } 
  }

  private playNext = (now: number) => {
    if (!this.decoder) {
      this.isPlaying = false;
      return;
    }
 
    if (this.jitterBuffer.length === 0) {
      if (this.isPlaying) {
        this.isPlaying = false;
        if (this.onLog) this.onLog(`\u26A0\uFE0F Buffer empty, stopping playback`);
        this.lastBufferEmptyTime = now;
      } else {
        if (this.lastBufferEmptyTime > 0 && now - this.lastBufferEmptyTime > 3000) {
          if (this.onLog) {
            this.onLog(`🔄 Buffer empty for 3s, resetting sync (firstSenderTs=${this.firstSenderTs}, firstPlayoutTime=${Math.round(this.firstPlayoutTime)})`);
          }
          this.firstSenderTs = -1;
          this.firstPlayoutTime = -1;
          this.lastBufferEmptyTime = 0;
        }
      }
      requestAnimationFrame(this.playNext);
      return;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`\u25B6\uFE06 Resuming playback`);
    }

    const packet = this.jitterBuffer[0];
    
    if (this.firstSenderTs === -1) {
      if (packet.type !== 'key') {
        this.jitterBuffer.shift();
        requestAnimationFrame(this.playNext);
        return;
      }
      this.firstSenderTs = packet.senderTs;
      this.firstPlayoutTime = now;
    }

    const videoTimeOffset = packet.senderTs - this.firstSenderTs;
    const targetPlayTime = this.firstPlayoutTime + videoTimeOffset + this.targetDelay;
    
    // Attempt 4: Panic Catch-up
    const delay = now - targetPlayTime;
    if (delay > 2000) {
      if (this.onLog) this.onLog(`🚀 Panic Catch-up: delay ${Math.round(delay)}ms > 2000ms, playing immediately!`);
      // Play immediately (fall through to decode)
    } else {
      // Normal catch-up: soft catch-up based on targetDelay and RTT
      const dropThreshold = this.targetDelay * 0.65 + this.currentRtt * 0.5;
      if (delay > dropThreshold) {
        if (this.onLog) {
          this.onLog(`⏭️ Skipping frame ${packet.frameId}: delay=${Math.round(delay)}ms, threshold=${Math.round(dropThreshold)}ms`);
        }
        this.jitterBuffer.shift();
        requestAnimationFrame(this.playNext);
        return;
      }

      if (now < targetPlayTime) {
        requestAnimationFrame(this.playNext);
        return;
      }
    }

    this.jitterBuffer.shift();
    
    try {
      const chunk = new EncodedVideoChunk({
        type: packet.type,
        timestamp: videoTimeOffset * 1000, 
        data: packet.raw
      });
      if (this.onLog && packet.frameId % 30 === 0) {
        this.onLog(`\u25B6\uFE0F Playing frame ${packet.frameId}: delay=${Math.round(now - targetPlayTime)}ms, targetDelay=${this.targetDelay}`);
      }
      this.decoder.decode(chunk);
    } catch (e) {
      if (this.onLog) this.onLog(`\u274C Decode error: ${e.message}`);
      this.firstSenderTs = -1;
    }
    
    requestAnimationFrame(this.playNext);
  };

  public getStats() {
    return {
      targetDelay: Math.round(this.targetDelay),
      bufferLength: this.jitterBuffer.length,
      firstSenderTs: this.firstSenderTs,
      firstPlayoutTime: this.firstPlayoutTime
    };
  }

  public setRotation(degrees: number) {
    this.rotation = degrees % 360;
    
    // iPhone front camera mirror + extra 180° compensation
    if (/iPhone|iPad/.test(navigator.userAgent)) {
      this.mirror = true;           // front camera is always mirrored
      this.rotation = (this.rotation + 180) % 360;
    }
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.onLog) this.onLog(`🔄 Applied rotation: ${this.rotation}° (mirror=${this.mirror})`);
  }

  public setMirror(enabled: boolean) {
    this.mirror = enabled;
  }

  public setFlip(enabled: boolean) {
    this.flip = enabled;
  }

  public updateRTT(rtt: number) {
    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();
    
    const sorted = [...this.rttHistory].sort((a,b)=>a-b);
    let median = sorted[Math.floor(sorted.length/2)];
    
    // Protection against Zombie RTT
    if (median > 2000) {
      median = this.currentRtt || 150;
      this.rttHistory = [median];
    }

    const clamped = Math.min(median, 800);
    this.lastRttSmoothed = this.lastRttSmoothed 
      ? this.lastRttSmoothed * 0.7 + clamped * 0.3 
      : clamped;

    this.currentRtt = this.lastRttSmoothed;
    this.estimatedOneWay = Math.min(this.currentRtt / 2, 400); // hard cap 400ms one-way
  }

  public destroy() {
    this.isPlaying = false;
    this.jitterBuffer = [];
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) {}
      this.decoder = null;
    }
  }
}
