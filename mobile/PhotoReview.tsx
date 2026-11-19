import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useImage } from "@shopify/react-native-skia";
import { PHOTO_FILTERS, type PhotoFilter, type TapePosition } from "../shared/capture-context";
import FilteredPhoto from "./FilteredPhoto";

const filters = Object.keys(PHOTO_FILTERS) as PhotoFilter[];
const tapeLabels = { none: "없음", top: "위", center: "가운데", bottom: "아래" } as const;
const positions = ["none", "top", "center", "bottom"] as const;
const panels = { appearance: "필터 · 테이프", details: "설명 · 장소" } as const;
type Panel = keyof typeof panels;

interface PhotoReviewProps {
  uri: string;
  filter: PhotoFilter;
  tape?: TapePosition;
  locked: boolean;
  onFilter: (filter: PhotoFilter) => void;
  onTape: (position?: TapePosition) => void;
  receipt: ReactNode;
  children: ReactNode;
}

export default function PhotoReview({ uri, filter, tape, locked, onFilter, onTape, receipt, children }: PhotoReviewProps) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const image = useImage(uri);
  const previewLabel = [PHOTO_FILTERS[filter].label, tape && `${tapeLabels[tape]} 테이프`].filter(Boolean).join(", ");
  return (
    <>
      <View style={s.preview} accessible accessibilityRole="image" accessibilityLabel={`사진 미리보기, ${previewLabel}`}>
        <FilteredPhoto uri={uri} image={image} filter={filter} tape={tape} />
      </View>
      <ScrollView style={s.scroll} contentContainerStyle={s.tools} keyboardShouldPersistTaps="handled">
        <View style={s.row}>
          {(["appearance", "details"] as const).map(key => (
            <Pressable key={key} accessibilityRole="button" accessibilityState={{ expanded: panel === key }}
              onPress={() => setPanel(current => current === key ? null : key)}
              style={({ pressed }) => [s.tab, panel === key && s.activeTab, pressed && s.pressed]}>
              <Text style={s.label}>{panels[key]}</Text>
              <View style={[s.chevron, panel === key && s.chevronUp]} />
            </Pressable>
          ))}
        </View>
        {panel === "appearance" && (
          <>
            <View style={s.group}>
              <Text style={s.heading}>필터</Text>
              <View style={s.row} accessibilityRole="radiogroup" accessibilityLabel="사진 필터">
                {filters.map(option => (
                  <Pressable key={option} accessibilityRole="radio" accessibilityLabel={`${PHOTO_FILTERS[option].label} 필터`}
                    disabled={locked || !image} accessibilityState={{ checked: filter === option, disabled: locked || !image }}
                    onPress={() => onFilter(option)}
                    style={({ pressed }) => [s.filter, pressed && s.pressed, locked && s.disabled]}>
                    <View style={[s.frame, filter === option && s.selectedFrame]}>
                      <View style={s.thumbnail}>
                        <FilteredPhoto uri={uri} image={image} filter={option} thumbnail />
                      </View>
                    </View>
                    <Text style={[s.option, filter === option && s.selectedLabel]}>{PHOTO_FILTERS[option].label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={s.group}>
              <Text style={s.heading}>테이프 위치</Text>
              <View style={s.row} accessibilityRole="radiogroup" accessibilityLabel="테이프 위치">
                {positions.map(position => {
                  const value = position === "none" ? undefined : position;
                  const selected = tape === value;
                  return (
                    <Pressable key={position} accessibilityRole="radio" accessibilityLabel={`테이프 ${tapeLabels[position]}`}
                      accessibilityState={{ checked: selected, disabled: locked || !image }} disabled={locked || !image}
                      style={({ pressed }) => [s.position, selected && s.selectedPosition, pressed && s.pressed, locked && s.disabled]}
                      onPress={() => onTape(value)}>
                      <Text style={[s.option, selected && s.selectedLabel]}>{tapeLabels[position]}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </>
        )}
        {panel === "details" && children}
        {receipt}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  preview: { flex: 1, backgroundColor: "#20221d" },
  scroll: { flexGrow: 0, maxHeight: "48%" },
  tools: { paddingHorizontal: 16, paddingVertical: 8, gap: 16 },
  row: { width: "100%", flexDirection: "row", alignItems: "stretch", gap: 8 },
  tab: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderBottomWidth: 2, borderColor: "#e7e9e1" },
  activeTab: { borderColor: "#20221d" },
  label: { flexShrink: 1, color: "#20221d", fontSize: 15, fontWeight: "600" },
  chevron: { width: 7, height: 7, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: "#20221d", transform: [{ rotate: "45deg" }] },
  chevronUp: { transform: [{ rotate: "225deg" }] },
  group: { gap: 8 },
  heading: { fontSize: 14, fontWeight: "700", color: "#20221d" },
  filter: { flex: 1, minHeight: 48, gap: 4, alignItems: "stretch" },
  frame: { height: 52, padding: 2, borderWidth: 2, borderColor: "transparent", borderRadius: 8 },
  selectedFrame: { borderColor: "#20221d" },
  thumbnail: { flex: 1, borderRadius: 4, overflow: "hidden" },
  option: { color: "#20221d", textAlign: "center", fontSize: 13 },
  selectedLabel: { fontWeight: "800", textDecorationLine: "underline" },
  position: { flex: 1, minHeight: 48, justifyContent: "center", padding: 4, borderWidth: 1, borderColor: "#d9ddd0", borderRadius: 10 },
  selectedPosition: { backgroundColor: "#d4ff3f", borderColor: "#20221d" },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.55 },
});
