import { lazy, Suspense, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Post } from "../shared/types";
import type { TapePosition } from "../shared/capture-context";
import { PhotoTape } from "./PhotoTape";

const VideoPlayer = lazy(() => import("./PostVideoPlayer"));

function TapedPhoto({ post, position }: { post: Post; position: TapePosition }) {
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [ratio, setRatio] = useState(0);
  const [peeled, setPeeled] = useState(false);
  const image = useRef<Image>(null);
  const width = Math.min(frame.width, frame.height * ratio);
  const height = ratio ? width / ratio : 0;
  const aspectRatio = ratio ? Math.max(.75, Math.min(1.8, ratio)) : 1;
  return <View style={[s.media, s.photoFrame, { aspectRatio }]} onLayout={({ nativeEvent: { layout } }) => {
    setFrame(current => current.width === layout.width && current.height === layout.height
      ? current : { width: layout.width, height: layout.height });
  }}>
    <Image ref={image} accessible source={{ uri: post.image_url }} resizeMode="contain"
      style={[StyleSheet.absoluteFill, { opacity: ratio ? 1 : 0 }]} accessibilityLabel={post.caption || "직접 촬영한 사진"}
      onLoad={event => {
        const source = event.nativeEvent.source;
        if (source.height > 0) setRatio(source.width / source.height);
      }} />
    {!peeled && width > 0 && <View pointerEvents="box-none" style={{ width, height }}>
      <PhotoTape position={position} frameWidth={width} frameHeight={height} onPeel={() => {
        setPeeled(true);
        if (image.current) AccessibilityInfo.sendAccessibilityEvent(image.current, "focus");
      }} />
    </View>}
  </View>;
}

export default function PostMedia({ post }: { post: Post }) {
  const [playing, setPlaying] = useState(false);
  if (post.media_type !== "video" && post.tape)
    return <TapedPhoto key={post.id + post.image_url} post={post} position={post.tape} />;
  if (post.media_type !== "video")
    return <Image source={{ uri: post.image_url }} style={s.media} accessibilityLabel={post.caption || "직접 촬영한 사진"} />;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="영상 재생" accessibilityHint={post.caption || undefined}
      style={({ pressed }) => [s.media, s.video, pressed && s.pressed]} onPress={() => setPlaying(true)}>
      {!!post.poster_url && <Image accessible={false} source={{ uri: post.poster_url }} style={StyleSheet.absoluteFill} />}
      <View style={s.play}><Text style={s.playLabel}>영상 재생</Text></View>
    </Pressable>
    {playing && <Modal animationType="slide" onRequestClose={() => setPlaying(false)}>
      <SafeAreaView style={s.screen}>
        <Pressable accessibilityRole="button" style={({ pressed }) => [s.close, pressed && s.pressed]} onPress={() => setPlaying(false)}>
          <Text style={s.playLabel}>닫기</Text>
        </Pressable>
        <Suspense fallback={<ActivityIndicator accessibilityLabel="영상 불러오는 중" color="white" />}>
          <VideoPlayer uri={post.image_url} />
        </Suspense>
      </SafeAreaView>
    </Modal>}
  </>;
}
const s = StyleSheet.create({
  media: { width: "100%", aspectRatio: 1, backgroundColor: "#e7e9e1", borderRadius: 12 },
  photoFrame: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  video: { backgroundColor: "#20221d", justifyContent: "center", alignItems: "center", overflow: "hidden" },
  play: { borderWidth: 1, borderColor: "#707369", backgroundColor: "#20221d", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 18 },
  playLabel: { color: "white", fontWeight: "700" },
  screen: { backgroundColor: "#20221d", flex: 1 },
  close: { minWidth: 48, minHeight: 48, alignSelf: "flex-end", justifyContent: "center", paddingHorizontal: 20 },
  pressed: { opacity: 0.7 },
});
