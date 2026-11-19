import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { TapePosition } from "../shared/capture-context";

const paper = require("../public/images/photo-tape.png");

export function PhotoTape({ position, frameWidth, frameHeight, onPeel }: {
  position: TapePosition; frameWidth: number; frameHeight: number; onPeel?: () => void;
}) {
  const width = frameWidth * .48;
  const height = Math.min(width * .22, frameHeight * .2);
  const targetHeight = onPeel ? Math.max(48, height) : height;
  const y = { top: .25, center: .5, bottom: .75 }[position] * frameHeight;
  const animation = useRef(new Animated.Value(0)).current;
  const peeling = useRef(false);
  const interactive = !!onPeel;
  const [reducedMotion, setReducedMotion] = useState(true);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!interactive) return;
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { active = false; sub.remove(); };
  }, [interactive]);
  useEffect(() => () => animation.stopAnimation(), [animation]);

  function peel() {
    if (!onPeel || peeling.current) return;
    peeling.current = true;
    if (reducedMotion) return onPeel();
    Animated.timing(animation, { toValue: 1, duration: 180, useNativeDriver: true }).start(({ finished }) => {
      if (finished) onPeel();
    });
  }
  const bounds = {
    left: (frameWidth - width) / 2, top: y - targetHeight / 2, width, height: targetHeight,
  };
  const strip = <View accessible={false} pointerEvents="none" style={[s.paper, { width, height }]}>
    <Image accessible={false} source={paper} resizeMode="stretch" style={{ width, height }} />
    {onPeel && <Text accessible={false} allowFontScaling={false} style={s.stamp}>떼기</Text>}
  </View>;
  if (!onPeel) return <View pointerEvents="none" accessible={false} style={[s.control, bounds]}>{strip}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel="테이프 떼기" onPress={peel} style={[s.control, bounds]}
    onTouchStart={event => {
      touch.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    }}
    onTouchCancel={() => { touch.current = null; }}
    onTouchEnd={event => {
      const first = touch.current;
      touch.current = null;
      if (!first) return;
      const dx = Math.abs(event.nativeEvent.pageX - first.x);
      const dy = Math.abs(event.nativeEvent.pageY - first.y);
      if (dx >= 24 && dx > dy * 1.4) peel();
    }}>
    <Animated.View pointerEvents="none" style={{
      opacity: animation.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
      transform: [{ translateX: animation.interpolate({ inputRange: [0, 1], outputRange: [0, -width * .07] }) },
        { scaleX: animation.interpolate({ inputRange: [0, 1], outputRange: [1, .84] }) }],
    }}>{strip}</Animated.View>
  </Pressable>;
}

const s = StyleSheet.create({
  control: { position: "absolute", alignItems: "center", justifyContent: "center", transform: [{ rotate: "-3deg" }] },
  paper: { justifyContent: "center", alignItems: "flex-end" },
  stamp: { position: "absolute", right: "12%", fontSize: 12, fontWeight: "600", color: "#59472c" },
});
