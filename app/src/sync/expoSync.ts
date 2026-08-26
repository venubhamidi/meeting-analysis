import NetInfo from '@react-native-community/netinfo';
import { File } from 'expo-file-system';

import type { SqlDb } from '../db/adapter';
import { createApi } from './api';
import { syncOnce, type Connectivity, type SyncOutcome } from './engine';
import { syncDownOnce } from './syncDown';

/**
 * Wires the sync engine to the device: real files, real connectivity, the
 * real API. The engine itself stays free of Expo so it can be tested in Node.
 */
export type SyncConfig = { baseUrl: string; token: string };

export async function currentConnectivity(): Promise<Connectivity> {
  const state = await NetInfo.fetch();
  return {
    online: Boolean(state.isConnected && state.isInternetReachable !== false),
    wifi: state.type === 'wifi' || state.type === 'ethernet',
  };
}

export function createSync(db: SqlDb, config: SyncConfig) {
  const api = createApi(config.baseUrl, config.token);
  let running = false;

  /** Only one pass at a time; a second trigger while running is a no-op. */
  const run = async (): Promise<SyncOutcome | null> => {
    if (running) return null;
    running = true;
    try {
      const net = await currentConnectivity();
      const up = await syncOnce(
        {
          db,
          api,
          readSegment: async (path) => new Uint8Array(await new File(path).bytes()),
          now: () => new Date(),
        },
        net
      );
      // Pulling results down is cheap and not worth holding back for WiFi —
      // transcripts are text, unlike the audio going the other way.
      if (net.online) await syncDownOnce(db, api);
      return up;
    } finally {
      running = false;
    }
  };

  /**
   * Runs on connectivity regained. SPEC.md §4.3 also lists app foreground and
   * background fetch windows; foreground is wired in App.tsx, and background
   * execution is deliberately not depended upon on iOS.
   */
  const start = (): (() => void) => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) void run();
    });
    void run();
    return unsubscribe;
  };

  return { run, start };
}
