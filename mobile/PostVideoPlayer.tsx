import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { StyleSheet, Text } from "react-native";

export default function PostVideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, instance => { instance.play(); });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  if (status === "error")
    return <Text accessibilityRole="alert" style={s.error}>영상을 재생하지 못했어요. 닫고 다시 시도해 주세요.</Text>;
  return <VideoView player={player} nativeControls contentFit="contain" style={s.video} />;
}
const s = StyleSheet.create({
  video: { flex: 1 },
  error: { color: "white", padding: 20, lineHeight: 24 },
});
