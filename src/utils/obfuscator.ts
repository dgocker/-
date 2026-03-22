export async function obfuscateSplit(raw: Uint8Array, frameId: number = 0, senderTs: number = 0): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const chunks: Uint8Array[] = [];
  
  // 1. Динамический MTU (от 800 до 1180 байт) для размытия PSD-сигнатуры
  while(offset < raw.length) {
     const size = Math.min(raw.length - offset, 800 + Math.floor(Math.random() * 380));
     chunks.push(raw.subarray(offset, offset + size));
     offset += size;
  }
  const partsCount = chunks.length;

  for (let i = 0; i < partsCount; i++) {
    const chunk = chunks[i];
    // 2. Случайный паддинг (0-64 байта мусора в конце пакета)
    const paddingSize = Math.floor(Math.random() * 64);
    
    // Заголовок 12 байт + данные + паддинг
    const part = new Uint8Array(chunk.length + 12 + paddingSize);
    
    // 3. Соль строго от 100 до 250 (не пересекается с аудио 1, 3 и шумом 99)
    const salt = 100 + Math.floor(Math.random() * 150);
    part[0] = salt;
    
    // 4. XOR-обфускация метаданных
    part[1] = (frameId & 0xFF) ^ salt;
    part[2] = ((frameId >> 8) & 0xFF) ^ salt;
    part[3] = (senderTs & 0xFF) ^ salt;
    part[4] = ((senderTs >> 8) & 0xFF) ^ salt;
    part[5] = ((senderTs >> 16) & 0xFF) ^ salt;
    part[6] = ((senderTs >> 24) & 0xFF) ^ salt;
    part[7] = (i & 0xFF) ^ salt;
    part[8] = ((i >> 8) & 0xFF) ^ salt;
    part[9] = (partsCount & 0xFF) ^ salt;
    part[10] = ((partsCount >> 8) & 0xFF) ^ salt;
    part[11] = paddingSize ^ salt; // FIX: Теперь длина мусора тоже под XOR
    
    part.set(chunk, 12); // Вставляем полезную нагрузку (H.264)
    
    // Заполняем паддинг случайным мусором
    for(let p = 0; p < paddingSize; p++) {
        part[12 + chunk.length + p] = Math.floor(Math.random() * 256);
    }
    parts.push(part);
  }
  return parts;
}

export async function deobfuscateAssemble(chunks: Uint8Array[]): Promise<{ data: Uint8Array; senderTs: number }> {
  try {
    // Снимаем XOR и отрезаем паддинг
    const unxored = chunks.map(c => {
        const salt = c[0];
        const padLen = c[11] ^ salt; // FIX: Снимаем XOR
        const frameId = (c[1] ^ salt) | ((c[2] ^ salt) << 8);
        const senderTs = ((c[3] ^ salt) | ((c[4] ^ salt) << 8) | ((c[5] ^ salt) << 16) | ((c[6] ^ salt) << 24)) >>> 0;
        const idx = (c[7] ^ salt) | ((c[8] ^ salt) << 8);
        
        // Извлекаем только зашифрованный H.264
        const payload = c.subarray(12, c.length - padLen);
        return { frameId, senderTs, idx, payload, key: `${frameId}|${idx}` };
    });

    const sorted = unxored.sort((a, b) => a.idx - b.idx);
    const senderTs = sorted[0].senderTs;

    const seen = new Set<string>();
    const deduped = sorted.filter(c => {
      if (seen.has(c.key)) return false;
      seen.add(c.key);
      return true;
    });

    const fullSize = deduped.reduce((sum, c) => sum + c.payload.length, 0);
    const result = new Uint8Array(fullSize);
    let offset = 0;
    for (const c of deduped) {
      result.set(c.payload, offset);
      offset += c.payload.length;
    }

    return { data: result, senderTs };
  } catch (e) {
    console.error('❌ deobfuscateAssemble error:', e);
    throw e;
  }
}
