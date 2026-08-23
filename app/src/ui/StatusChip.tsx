import { Text, View } from 'react-native';
import type { RecordingState } from '../recording/states';

const COLOR: Record<RecordingState, string> = {
  recording: '#b91c1c',
  recorded: '#a16207',
  queued: '#a16207',
  uploading: '#1d4ed8',
  uploaded: '#1d4ed8',
  transcribing: '#1d4ed8',
  analyzed: '#15803d',
  synced: '#15803d',
  stuck: '#b91c1c',
};

const LABEL: Record<RecordingState, string> = {
  recording: 'recording',
  recorded: 'on phone only',
  queued: 'waiting to upload',
  uploading: 'uploading',
  uploaded: 'uploaded',
  transcribing: 'transcribing',
  analyzed: 'analyzed',
  synced: 'synced',
  stuck: 'needs attention',
};

export function StatusChip({ state }: { state: RecordingState }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: COLOR[state],
      }}>
      <Text style={{ color: COLOR[state], fontSize: 12 }}>{LABEL[state]}</Text>
    </View>
  );
}
