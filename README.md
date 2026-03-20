# Secure Relay Video Calling Architecture (V2.1)

Этот проект реализует нестандартную архитектуру защищенных видеозвонков, оптимизированную для работы в условиях жестких сетевых ограничений и цензуры.

## 核心 (Core Concept)
Система использует **Secure Relay** — передачу сырых медиаданных (H.264 Annex B, Level 3.1 + PCM) через защищенный WebSocket-туннель. Мы не используем стандартный WebRTC стек (RTP/SRTP), что делает трафик неразличимым для многих систем DPI и позволяет полностью контролировать битрейт и задержки на уровне приложения через WebCodecs API.

---

## 🔐 Mandatory E2EE (End-to-End Encryption)
Шифрование является **обязательным**. Если ключи не согласованы, передача медиа блокируется.

*   **Key Exchange:** ECDH (Elliptic Curve Diffie-Hellman) на кривой P-256. Публичные ключи передаются через Socket.io в момент вызова.
*   **Encryption Algorithm:** AES-256-GCM. Обеспечивает не только конфиденциальность, но и проверку целостности (AuthTag).
*   **V2 Packet Protocol:** Каждый пакет содержит маркер типа данных:
    - `type 1`: Raw PCM Audio (fallback)
    - `type 3`: **Encrypted E2EE Audio** (standart)
    - `0xFF marker`: **Encrypted E2EE Video** (H.264 Annex B, obfuscated)
*   **Perfect Forward Secrecy:** Ключи сессии генерируются заново для каждого звонка, живут только в памяти и уничтожаются сразу после завершения вызова (`sharedSecretRef.current = null`).

---

## 📈 Adaptive Bitrate & Congestion Control
Алгоритм в `AdaptiveJPEGEngine.ts` вдохновлен Google Congestion Control (GCC), но адаптирован для WebSocket:

1.  **RTT Gradient Analysis:** Система следит не за пингом, а за его ростом. Перегрузка фиксируется, если RTT растет в течение 200 мс.
2.  **True Throughput ($R_{hat}$):** Вычисляется реальная скорость поглощения данных сетью: `(BytesSent - BufferedAmount) / Δt`.
3.  **FSM States:** 
    - `probe`: Агрессивный поиск предела канала.
    - `steady`: Стабильное удержание.
    - `congested`: Мгновенный сброс битрейта до 85% от $R_{hat}$.
    - `recovery`: Плавный выход из затора.
4.  **Token Bucket Pacer:** Сглаживание трафика для предотвращения всплесков (micro-bursts), которые забивают очереди роутеров.

---

## 📱 Platform Optimizations

### iOS Safari
- **iosBufferPanic:** Автоматический сброс очередей при RTT > 1.5 сек (защита от "зависаний" WebKit).
- **Video Opacity Hack:** Видео-элемент остается активным с прозрачностью 0.01 для поддержания работы аудио-контента в фоновом режиме.

### Android 13+
- **MediaSource Bypass**: В режиме Secure Relay используется прямой захват через `VideoEncoder` и программно-аппаратное декодирование, что обходит ограничения `MediaSource` на некоторых версиях мобильных ОС.

---

## 🎙️ Audio & DPI Masking
- **FORMAT:** PCM 8-bit, 8000 Hz, Mono (~64 kbps).
- **Masking:** Добавление случайного padding (мусорных байт) к аудиопакетам, чтобы скрыть "голосовой" паттерн трафика от систем анализа.
- **Latency:** Буфер захвата — 256 семплов (~32 мс задержки).

---

## 🚀 How to Run locally

1.  `npm install`
2.  Настройте токен в `.env.local`
3.  `npm run dev`

---
**Security Note:** Сервер сигналов является "слепым". Он пересылает публичные ключи, но не имеет доступа к `sharedSecret`. Весь медиа-трафик проходит через релей, который видит только зашифрованные AES-GCM пакеты.
