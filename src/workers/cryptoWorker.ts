// src/workers/cryptoWorker.ts

let cryptoKey: CryptoKey | null = null;

// Обработка сообщений от главного потока
self.onmessage = async (event) => {
  const { type, payload, keyData, iv, id } = event.data;

  try {
    if (type === 'INIT_KEY') {
      // Инициализация ключа при старте звонка
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
      cryptoKey = keyMaterial;
      self.postMessage({ type: 'KEY_READY' });
    } 
    else if (type === 'CLEAR_KEY') {
      cryptoKey = null;
      self.postMessage({ type: 'KEY_CLEARED' });
    }
    else if (type === 'ENCRYPT_VIDEO' || type === 'ENCRYPT_AUDIO' || type === 'DECRYPT_VIDEO' || type === 'DECRYPT_AUDIO') {
      if (!cryptoKey) {
        self.postMessage({ type: 'ERROR', error: 'Key not initialized', id });
        return;
      }

      const isEncrypt = type.startsWith('ENCRYPT');
      // Конвертируем ArrayBuffer обратно в Uint8Array если нужно
      const dataArray = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
      const ivArray = iv instanceof ArrayBuffer ? new Uint8Array(iv) : iv;

      const startTime = performance.now();
      
      try {
        const resultBuffer = isEncrypt 
          ? await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: ivArray, tagLength: 128 },
              cryptoKey,
              dataArray
            )
          : await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: ivArray, tagLength: 128 },
              cryptoKey,
              dataArray
            );

        const duration = performance.now() - startTime;
        if (duration > 5) {
          console.warn(`[CryptoWorker] Slow ${isEncrypt ? 'encryption' : 'decryption'}: ${duration.toFixed(2)}ms for ${dataArray.byteLength} bytes`);
        }

        const responseType = isEncrypt 
          ? (type === 'ENCRYPT_VIDEO' ? 'ENCRYPTED_VIDEO' : 'ENCRYPTED_AUDIO')
          : (type === 'DECRYPT_VIDEO' ? 'DECRYPTED_VIDEO' : 'DECRYPTED_AUDIO');
        
        // Отправляем обратно в главный поток
        const response: any = { 
          type: responseType, 
          data: resultBuffer,
          id: id
        };
        if (isEncrypt) response.iv = ivArray;

        (self as any).postMessage(response, [resultBuffer]);
      } catch (e: any) {
        self.postMessage({ type: 'ERROR', error: `Crypto operation failed: ${e.message}`, id });
      }
    }
  } catch (error) {
    console.error('[CryptoWorker] Error:', error);
    self.postMessage({ 
      type: 'ERROR', 
      error: error instanceof Error ? error.message : String(error),
      id: id
    });
  }
};

export {};
