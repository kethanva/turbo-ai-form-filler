// Minimal chrome extension API stub so modules that reference `chrome.*` at
// import time (background/content scripts) don't throw in a plain jsdom test
// environment. Extend as needed — keep it the smallest stub that unblocks
// import-time evaluation, not a full behavioral mock.
(globalThis as any).chrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    sendMessage: (_message: unknown, callback?: (response: unknown) => void) => {
      callback?.(undefined);
    },
    onMessage: {
      addListener: () => { /* no-op */ },
    },
    onInstalled: {
      addListener: () => { /* no-op */ },
    },
    lastError: undefined,
  },
  storage: {
    local: {
      get: (_keys: unknown, callback: (result: Record<string, unknown>) => void) => callback({}),
      set: (_items: unknown, callback?: () => void) => callback?.(),
    },
    sync: {
      get: (_keys: unknown, callback: (result: Record<string, unknown>) => void) => callback({}),
      set: (_items: unknown, callback?: () => void) => callback?.(),
    },
    onChanged: {
      addListener: () => { /* no-op */ },
      removeListener: () => { /* no-op */ },
    },
  },
  commands: {
    onCommand: {
      addListener: () => { /* no-op */ },
    },
  },
};
