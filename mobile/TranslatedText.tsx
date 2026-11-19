import { useEffect, useState, type ReactNode } from "react";
import { Alert, Image, Linking, Pressable, StyleSheet, Text, View, type TextProps } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { createTranslationQueue, translationLanguage, type TranslationEngine } from "./lib/local-translation";

const requestTranslation = createTranslationQueue(requireOptionalNativeModule<TranslationEngine>("NepeelTranslation"));
const credit = require("./modules/nepeel-translation/assets/google-translate.png");

export default function TranslatedText({ text, target = translationLanguage(), prefix, style }: {
  text: string;
  target?: string;
  prefix?: ReactNode;
  style?: TextProps["style"];
}) {
  const [result, setResult] = useState<{ source: string; target: string; text: string; original: boolean } | null>(null);
  useEffect(() => {
    setResult(null);
    return requestTranslation(text, target, translated => setResult({
      source: text, target, text: translated, original: false,
    }));
  }, [text, target]);
  const current = result?.source === text && result.target === target ? result : null;
  const ko = target === "ko";
  const label = current?.original ? (ko ? "번역 보기" : "Show translation") : (ko ? "원문 보기" : "Show original");
  return <>
    <Text style={style}>{prefix}{current && !current.original ? current.text : text}</Text>
    {current && <View style={s.controls}>
      <Pressable style={s.action} accessibilityRole="button" onPress={() => setResult({...current, original: !current.original})}>
        <Text style={s.label}>{label}</Text>
      </Pressable>
      {!current.original && <Pressable accessibilityRole="button" style={s.action}
        accessibilityLabel={ko ? "Google 번역 정보" : "About Google Translate"}
        onPress={() => Alert.alert("Google Translate",
          ko ? "텍스트는 기기에서 번역됩니다. Google은 번역의 정확성, 신뢰성 또는 상품성, 특정 목적 적합성 및 비침해에 관한 명시적·묵시적 보증을 제공하지 않습니다." :
            "Google Translate processes text on your device. Google disclaims express and implied warranties for translations, including accuracy, reliability, merchantability, fitness for a particular purpose and noninfringement.",
          [{text: ko ? "안내" : "Learn more", onPress: () => { void Linking.openURL("https://cloud.google.com/translate").catch(() => {}); }}, {text: ko ? "닫기" : "Close"}])}>
        <Image accessible={false} source={credit} style={s.credit} />
      </Pressable>}
    </View>}
  </>;
}

const s = StyleSheet.create({
  controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12 },
  action: { minHeight: 48, justifyContent: "center" },
  label: { color: "#51564b", fontSize: 13, fontWeight: "600" },
  credit: { width: 122, height: 16 },
});
