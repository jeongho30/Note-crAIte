/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: {
      call: (method: string, params?: unknown) => Promise<unknown>
      on: (event: string, cb: (data: unknown) => void) => () => void
    }
  }
}
