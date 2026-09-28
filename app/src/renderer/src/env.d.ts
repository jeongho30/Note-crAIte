export {}

declare global {
  interface Window {
    api: { call: (method: string, params?: unknown) => Promise<unknown> }
  }
}
