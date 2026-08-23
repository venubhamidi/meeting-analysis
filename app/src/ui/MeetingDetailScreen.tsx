import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAudioPlayer } from 'expo-audio';

import type { SqlDb } from '../db/adapter';
import {
  getRecording,
  listSegments,
  type RecordingRow,
  type SegmentRow,
} from '../db/recordings';
import { StatusChip } from './StatusChip';
import { bytes, clock, when } from './format';

export function MeetingDetailScreen({ db, id }: { db: SqlDb; id: string }) {
  const [row, setRow] = useState<RecordingRow | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [playing, setPlaying] = useState<number | null>(null);
  const player = useAudioPlayer();

  useEffect(() => {
    (async () => {
      setRow(await getRecording(db, id));
      setSegments(await listSegments(db, id));
    })();
  }, [db, id]);

  const play = (seg: SegmentRow) => {
    player.replace(seg.file_path);
    player.play();
    setPlaying(seg.seq);
  };

  if (!row) return null;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20 }}>{when(row.created_at)}</Text>
      <StatusChip state={row.state} />
      <Text style={{ color: '#6b7280' }}>
        {row.duration_seconds != null ? clock(row.duration_seconds * 1000) : '—'}
        {'  ·  '}
        {bytes(row.file_size_bytes)}
        {'  ·  '}
        {segments.length} segment{segments.length === 1 ? '' : 's'}
      </Text>
      <Text selectable style={{ color: '#9ca3af', fontSize: 11 }}>
        {row.id}
      </Text>

      {row.last_error && (
        <Text style={{ color: '#b91c1c' }}>Last error: {row.last_error}</Text>
      )}

      <View style={{ height: 1, backgroundColor: '#e5e7eb', marginVertical: 4 }} />

      {segments.map((seg) => (
        <Pressable
          key={seg.seq}
          onPress={() => play(seg)}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingVertical: 10,
          }}>
          <Text>
            {playing === seg.seq ? '▶ ' : ''}Segment {seg.seq + 1}
          </Text>
          <Text style={{ color: '#6b7280' }}>
            {seg.duration_ms != null ? clock(seg.duration_ms) : 'length unknown'}
            {'  ·  '}
            {bytes(seg.size_bytes)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
