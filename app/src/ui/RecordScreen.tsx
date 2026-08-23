import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';

import type { RecordingSession } from '../recording/session';
import { clock } from './format';

export function RecordScreen({ session }: { session: RecordingSession }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);

  useEffect(() => {
    (async () => {
      const current = await getRecordingPermissionsAsync();
      setGranted(
        current.granted || (await requestRecordingPermissionsAsync()).granted
      );
    })();
  }, []);

  // Duration and the segment counter both change while recording.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const recording = session.currentId != null;
  const liveMs = recording ? session.activeRecorder.getStatus().durationMillis : 0;
  const totalMs = session.committedMs + liveMs;

  const toggle = async () => {
    setBusy(true);
    try {
      if (recording) await session.stop();
      else await session.start();
    } catch (e) {
      Alert.alert('Recording error', String(e));
    } finally {
      setBusy(false);
    }
  };

  if (granted === false) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 16 }}>
          Microphone access is off. Enable it in Settings to record meetings.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <Text style={{ fontSize: 56, fontVariant: ['tabular-nums'] }}>{clock(totalMs)}</Text>

      <Pressable
        onPress={toggle}
        disabled={busy || granted == null}
        style={{
          width: 160,
          height: 160,
          borderRadius: 80,
          backgroundColor: recording ? '#b91c1c' : '#111827',
          opacity: busy || granted == null ? 0.5 : 1,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Text style={{ color: 'white', fontSize: 20 }}>
          {recording ? 'Stop' : 'Record'}
        </Text>
      </Pressable>

      {/*
        The honest safety signal: how much audio would survive if the app died
        right now. Everything after the last committed segment is still at risk.
      */}
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text style={{ color: '#15803d' }}>
          {session.committedSegments} segment
          {session.committedSegments === 1 ? '' : 's'} saved (
          {clock(session.committedMs)})
        </Text>
        {recording && (
          <Text style={{ color: '#6b7280', fontSize: 12 }}>
            at risk if the app crashes now: {clock(liveMs)}
          </Text>
        )}
      </View>
    </View>
  );
}
