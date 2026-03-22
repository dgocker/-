export async function obfuscateSplit(raw: Uint8Array, frameId: number = 0, senderTs: number = 0): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  
  // Рассчитываем примерное количество частей для заголовка
  const avgChunkSize = 1000;
  const estimatedParts = Math.ceil(raw.length / avgChunkSize);

  let partIndex = 0;
  while (offset < raw.length) {
    // 1. Динамический размер чанка (MTU-obfuscation)
    // Рандомизируем размер от 800 до 1180 байт, чтобы размыть PSD-сигнатуру
    const chunkSize = Math.min(raw.length - offset, 800 + Math.floor(Math.random() * 380));
    const chunk = raw.subarray(offset, offset + chunkSize);
    
    // 2. Динамический размер паддинга (0-64 байта)
    const paddingSize = Math.floor(Math.random() * 64);
    const headerSize = 15;
    const part = new Uint8Array(chunk.length + headerSize + paddingSize);
    
    // 3. Заголовок-хамелеон со случайной солью (избегаем 1, 3 и 0xFF)
    const salt = 10 + Math.floor(Math.random() * 244);
    part[0] = salt; // Первый байт — соль
    
    // Обфусцируем метаданные через XOR с солью
    part[1] = (frameId & 0xFF) ^ salt;
    part[2] = ((frameId >> 8) & 0xFF) ^ salt;
    
    // senderTs (4 bytes)
    part[3] = (senderTs & 0xFF) ^ salt;
    part[4] = ((senderTs >> 8) & 0xFF) ^ salt;
    part[5] = ((senderTs >> 16) & 0xFF) ^ salt;
    part[6] = ((senderTs >> 24) & 0xFF) ^ salt;
    
    // partIndex (2 bytes)
    part[7] = (partIndex & 0xFF) ^ salt;
    part[8] = ((partIndex >> 8) & 0xFF) ^ salt;
    
    // totalParts (2 bytes - примерное значение для совместимости)
    part[9] = (estimatedParts & 0xFF) ^ salt;
    part[10] = ((estimatedParts >> 8) & 0xFF) ^ salt;
    
    // paddingSize and Start Flag
    part[11] = paddingSize ^ salt;
    part[12] = (offset === 0 ? 1 : 0) ^ salt;
    
    // Extra noise bytes in header (13-14)
    part[13] = Math.floor(Math.random() * 256) ^ salt;
    part[14] = Math.floor(Math.random() * 256) ^ salt;
    
    // Копируем данные полезной нагрузки
    part.set(chunk, headerSize);
    
    // Заполняем паддинг криптографическим шумом
    if (paddingSize > 0) {
      crypto.getRandomValues(part.subarray(headerSize + chunk.length));
    }
    
    parts.push(part);
    offset += chunkSize;
    partIndex++;
  }

  return parts;
}

export async function deobfuscateAssemble(chunks: Uint8Array[]): Promise<{ data: Uint8Array; senderTs: number }> {
  try {
    const headerSize = 15;
    
    // Декодируем заголовки и сортируем части
    const decodedParts = chunks.map(part => {
      const salt = part[0];
      const partIdx = (part[7] ^ salt) | ((part[8] ^ salt) << 8);
      const padding = part[11] ^ salt;
      const sTs = (part[3] ^ salt) | ((part[4] ^ salt) << 8) | ((part[5] ^ salt) << 16) | ((part[6] ^ salt) << 24);
      
      return {
        index: partIdx,
        padding: padding,
        senderTs: sTs >>> 0,
        data: part.subarray(headerSize, part.length - padding)
      };
    }).sort((a, b) => a.index - b.index);

    // Извлекаем senderTs из первого фрагмента
    const senderTs = decodedParts[0].senderTs;

    // Дедупликация (на случай сетевых повторов)
    const seen = new Set<number>();
    const deduped = decodedParts.filter(p => {
      if (seen.has(p.index)) return false;
      seen.add(p.index);
      return true;
    });

    const fullSize = deduped.reduce((sum, p) => sum + p.data.length, 0);
    const result = new Uint8Array(fullSize);
    let offset = 0;

    for (const p of deduped) {
      result.set(p.data, offset);
      offset += p.data.length;
    }

    return { data: result, senderTs };
  } catch (e) {
    console.error('❌ deobfuscateAssemble error:', e);
    throw e;
  }
}
