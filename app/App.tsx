import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { setAudioModeAsync, useAudioRecorder } from 'expo-audio';

import type { SqlDb } from './src/db/adapter';
import { openDb } from './src/db/expoDb';
import { runStartupRecovery } from './src/recording/expoRecovery';
import { RECORDING_OPTIONS, RecordingSession } from './src/recording/session';
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

  useEffect(() => {
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
    })();
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
