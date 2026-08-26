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
import { localTranscript } from '../sync/syncDown';
import type { TranscriptSegment } from '../sync/api';
import { StatusChip } from './StatusChip';
import { bytes, clock, when } from './format';

export function MeetingDetailScreen({ db, id }: { db: SqlDb; id: string }) {
  const [row, setRow] = useState<RecordingRow | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [playing, setPlaying] = useState<number | null>(null);
  const [tab, setTab] = useState<'transcript' | 'audio'>('transcript');
  const player = useAudioPlayer();

  useEffect(() => {
    (async () => {
      setRow(await getRecording(db, id));
      setSegments(await listSegments(db, id));
      setTranscript(await localTranscript(db, id));
    })();
  }, [db, id]);

  /**
   * Plays the segment file that contains a transcript moment. Segments are
   * ~60s each, so the file index is the minute; seeking within it to the exact
   * moment is phase 3's quote playback.
   */
  const playAt = (startMs: number) => {
    const index = Math.min(Math.floor(startMs / 60_000), segments.length - 1);
    const seg = segments[index];
    if (!seg) return;
    player.replace(seg.file_path);
    player.play();
    setPlaying(seg.seq);
  };

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

      <View style={{ flexDirection: 'row', gap: 18 }}>
        {(['transcript', 'audio'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)}>
            <Text
              style={{
                fontSize: 14,
                color: tab === t ? '#111827' : '#9ca3af',
                fontWeight: tab === t ? '600' : '400',
              }}>
              {t === 'transcript'
                ? `Transcript${transcript.length ? ` (${transcript.length})` : ''}`
                : `Audio (${segments.length})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'transcript' && transcript.length === 0 && (
        <Text style={{ color: '#6b7280', paddingVertical: 12 }}>
          {row.state === 'recorded' || row.state === 'queued' || row.state === 'uploading'
            ? 'Not uploaded yet. The transcript appears once the server has processed it.'
            : 'Waiting for the server to finish transcribing.'}
        </Text>
      )}

      {tab === 'transcript' &&
        transcript.map((t) => (
          <Pressable
            key={t.seq}
            onPress={() => playAt(t.start_ms)}
            style={{ paddingVertical: 8, gap: 3 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#1d4ed8' }}>
                {t.diarization_label ?? 'Speaker'}
              </Text>
              <Text style={{ fontSize: 11, color: '#9ca3af' }}>{clock(t.start_ms)}</Text>
              {t.low_confidence && (
                <Text style={{ fontSize: 11, color: '#b45309' }}>unclear</Text>
              )}
            </View>
            <Text style={{ fontSize: 15, lineHeight: 23 }}>{t.text_te}</Text>
          </Pressable>
        ))}

      {tab === 'audio' &&
        segments.map((seg) => (
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
