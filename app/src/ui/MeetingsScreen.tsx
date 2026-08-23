import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import type { SqlDb } from '../db/adapter';
import { listRecordings, pendingCount, type RecordingRow } from '../db/recordings';
import { StatusChip } from './StatusChip';
import { bytes, clock, when } from './format';

export function MeetingsScreen({
  db,
  version,
  onOpen,
}: {
  db: SqlDb;
  version: number;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    (async () => {
      setRows(await listRecordings(db));
      setPending(await pendingCount(db));
    })();
  }, [db, version]);

  return (
    <View style={{ flex: 1 }}>
      {pending > 0 && (
        <View style={{ backgroundColor: '#fef3c7', padding: 12 }}>
          <Text style={{ color: '#92400e' }}>
            {pending} recording{pending === 1 ? '' : 's'} still only on this phone
          </Text>
        </View>
      )}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={
          <Text style={{ padding: 24, color: '#6b7280' }}>No recordings yet.</Text>
        }
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: '#e5e7eb' }} />
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpen(item.id)} style={{ padding: 16, gap: 6 }}>
            <Text style={{ fontSize: 16 }}>{when(item.created_at)}</Text>
            <Text style={{ color: '#6b7280', fontSize: 13 }}>
              {item.duration_seconds != null ? clock(item.duration_seconds * 1000) : '—'}
              {'  ·  '}
              {bytes(item.file_size_bytes)}
            </Text>
            <StatusChip state={item.state} />
          </Pressable>
        )}
      />
    </View>
  );
}
