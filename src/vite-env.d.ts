/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STUN_URL: string
  readonly VITE_TURN_URL: string
  readonly VITE_TURN_USERNAME: string
  readonly VITE_TURN_CREDENTIAL: string
  readonly VITE_TELEGRAM_BOT_NAME: string
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
