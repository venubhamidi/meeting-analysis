import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { setAudioModeAsync, useAudioRecorder } from 'expo-audio';

import type { SqlDb } from './src/db/adapter';
import { openDb } from './src/db/expoDb';
import { runStartupRecovery } from './src/recording/expoRecovery';
import { RECORDING_OPTIONS, RecordingSession } from './src/recording/session';
import { createSync } from './src/sync/expoSync';
import { MeetingDetailScreen } from './src/ui/MeetingDetailScreen';
import { MeetingsScreen } from './src/ui/MeetingsScreen';
import { RecordScreen } from './src/ui/RecordScreen';

type Route = { tab: 'record' } | { tab: 'meetings'; open?: string };

export default function App() {
  const [db, setDb] = useState<SqlDb | null>(null);
  const [route, setRoute] = useState<Route>({ tab: 'record' });
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Two recorders so a segment rotation costs only the time to stop one.
  const recorderA = useAudioRecorder(RECORDING_OPTIONS);
  const recorderB = useAudioRecorder(RECORDING_OPTIONS);
  const sessionRef = useRef<RecordingSession | null>(null);
  const syncRef = useRef<ReturnType<typeof createSync> | null>(null);

  useEffect(() => {
    let stopSync: (() => void) | undefined;
    (async () => {
      const opened = await openDb();
      await runStartupRecovery(opened); // before any new recording can start
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        allowsBackgroundRecording: true,
        interruptionMode: 'doNotMix',
      });
      sessionRef.current = new RecordingSession(opened, [recorderA, recorderB], bump);
      setDb(opened);

      // Sync runs on connectivity regained and whenever the app comes forward.
      // Server details are build-time config; the app never holds API keys.
      const base = process.env.EXPO_PUBLIC_API_URL;
      const token = process.env.EXPO_PUBLIC_DEVICE_TOKEN;
      if (base && token) {
        const sync = createSync(opened, { baseUrl: base, token });
        syncRef.current = sync;
        stopSync = sync.start();
      }
    })();

    // A pass on every foreground, per §4.3.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncRef.current?.run().then(() => bump());
    });

    return () => {
      appState.remove();
      stopSync?.();
    };
    // Recorders are stable for the lifetime of the app; the session is created once.
  }, []);

  if (!db || !sessionRef.current) return null;
  const session = sessionRef.current;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: 'white' }}>
      <StatusBar style="dark" />

      <View style={{ flex: 1 }}>
        {route.tab === 'record' ? (
          <RecordScreen session={session} />
        ) : route.open ? (
          <MeetingDetailScreen db={db} id={route.open} />
        ) : (
          <MeetingsScreen
            db={db}
            version={version}
            onOpen={(id) => setRoute({ tab: 'meetings', open: id })}
          />
        )}
      </View>

      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e5e7eb' }}>
        {route.tab === 'meetings' && route.open ? (
          <Tab
            label="‹ Back"
            active={false}
            onPress={() => setRoute({ tab: 'meetings' })}
          />
        ) : null}
        <Tab
          label="Record"
          active={route.tab === 'record'}
          onPress={() => setRoute({ tab: 'record' })}
        />
        <Tab
          label="Meetings"
          active={route.tab === 'meetings'}
          onPress={() => {
            void syncRef.current?.run().then(() => bump());
            bump();
            setRoute({ tab: 'meetings' });
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1, padding: 14, alignItems: 'center' }}>
      <Text style={{ color: active ? '#111827' : '#9ca3af' }}>{label}</Text>
    </Pressable>
  );
}
