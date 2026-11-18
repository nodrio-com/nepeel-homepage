import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captureApi, type CertificateStatus } from "./lib/capture";
import {
  dismissFailedCapture, observeCertificates, pendingCaptures, retryCertificates, shareCertificate, shareFailedOriginal,
  type Certificate, type PendingCapture,
} from "./lib/certificates";

export const certificateLabel: Record<CertificateStatus, string> = {
  uploading: "원본 전송 중", queued: "발급 대기", minted: "인증서 발급 완료",
};

export default function CertificateHistory({ userId, close }: { userId: string; close: () => void }) {
  const [items, setItems] = useState<Certificate[]>([]);
  const [pending, setPending] = useState<PendingCapture[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    try {
      setPending(pendingCaptures(userId));
      const result = await captureApi<{ items: Certificate[] }>({ action: "listCertificates" }, userId);
      if (mounted.current && revision.current === request) {
        setItems(result.items);
        setMore(result.items.length === 50);
      }
    } catch (e) {
      if (mounted.current && revision.current === request)
        setError(e instanceof Error ? e.message : "인증 기록을 불러오지 못했어요.");
    } finally {
      if (mounted.current && revision.current === request) setLoading(false);
    }
  }, [userId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const stop = observeCertificates(event => {
      if (event.owner === userId && AppState.currentState === "active") void refresh();
    });
    const lifecycle = AppState.addEventListener("change", state => {
      setForeground(state === "active");
      if (state === "active") void refresh();
    });
    return () => { mounted.current = false; stop(); lifecycle.remove(); };
  }, [refresh, userId]);
  // A mint completes asynchronously. Refresh only while there is an outstanding receipt.
  const awaitingMint = items.some(item => item.status !== "minted");
  useEffect(() => {
    if (!foreground || !awaitingMint || loading || loadingMore || items.length > 50 || error) return;
    const timer = setTimeout(() => void refresh(), 30_000);
    return () => clearTimeout(timer);
  }, [foreground, awaitingMint, loading, loadingMore, items.length, error, refresh]);
  function retry() {
    retryCertificates(userId);
    void refresh();
  }
  async function earlier() {
    const last = items.at(-1);
    if (!last || loading || loadingMore) return;
    const before = { createdAt: last.createdAt, id: last.id };
    const request = ++revision.current;
    setLoadingMore(true);
    setError("");
    try {
      const result = await captureApi<{ items: Certificate[] }>({ action: "listCertificates", before }, userId);
      if (mounted.current && revision.current === request) {
        setItems(current => [...current, ...result.items]);
        setMore(result.items.length === 50);
      }
    } catch (e) {
      if (mounted.current && revision.current === request)
        setError(e instanceof Error ? e.message : "이전 인증서를 불러오지 못했어요.");
    } finally {
      if (mounted.current && revision.current === request) setLoadingMore(false);
    }
  }
  async function updateShare(item: Certificate, revoke: boolean) {
    if (lock.current) return;
    lock.current = true;
    setActing(item.id);
    setError("");
    try {
      if (revoke)
        await captureApi({ action: "revokeCertificateShare", id: item.id }, userId);
      else await shareCertificate(userId, item.id, () => mounted.current);
      if (mounted.current) setItems(current => current.map(row => row.id === item.id ? { ...row, shared: !revoke } : row));
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "공유 링크를 확인하지 못했어요.");
    } finally {
      lock.current = false;
      if (mounted.current) setActing("");
    }
  }
  async function exportOriginal(job: PendingCapture) {
    if (lock.current) return;
    lock.current = true;
    setActing(job.challenge.id);
    try {
      await shareFailedOriginal(userId, job, () => mounted.current);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "원본을 공유하지 못했어요.");
    } finally {
      lock.current = false;
      if (mounted.current) setActing("");
    }
  }
  function discard(job: PendingCapture) {
    const removeLabel = job.hasOriginal ? "원본 삭제" : "기록 삭제";
    Alert.alert(job.hasOriginal ? "촬영 원본을 삭제할까요?" : "실패 기록을 삭제할까요?", "이 기기에서 삭제합니다.", [
      { text: "취소", style: "cancel" },
      { text: removeLabel, style: "destructive", onPress: () => {
        if (mounted.current) dismissFailedCapture(userId, job.challenge.id);
      } },
    ]);
  }
  return (
    <Modal visible onRequestClose={close} animationType="slide">
      <SafeAreaView style={s.screen}>
        <View style={s.header}>
          <Text accessibilityRole="header" style={s.title}>내 촬영 인증서</Text>
          <Pressable style={s.button} accessibilityRole="button" onPress={close}><Text>닫기</Text></Pressable>
        </View>
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          contentContainerStyle={s.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={retry} />}
          ListHeaderComponent={<>
            {!!error && <View style={s.entry}>
              <Text accessibilityRole="alert" style={s.error}>{error}</Text>
              <Pressable accessibilityRole="button" style={s.button} onPress={retry}><Text>다시 불러오기</Text></Pressable>
            </View>}
            {pending.slice().reverse().map(job => (
              <View key={job.challenge.id} style={s.entry}>
                <Text style={s.name}>{job.mediaKind === "photo" ? "사진" : "영상"} · {job.error ? "인증 실패" : "전송 대기"}</Text>
                <Text style={s.detail}>{new Date(job.createdAt).toLocaleString("ko-KR")}</Text>
                {job.error ? <>
                  <Text style={s.error}>{job.error}</Text>
                  {!job.hasOriginal && <Text style={s.detail}>이 기기에 원본이 남아 있지 않아요.</Text>}
                  <View style={s.actions}>
                    {job.hasOriginal && <Pressable accessibilityRole="button" disabled={!!acting} style={s.primary} onPress={() => void exportOriginal(job)}><Text style={s.primaryText}>원본 공유</Text></Pressable>}
                    <Pressable accessibilityRole="button" disabled={!!acting} style={s.button} onPress={() => discard(job)}><Text>{job.hasOriginal ? "원본 삭제" : "기록 삭제"}</Text></Pressable>
                  </View>
                </> : <Pressable accessibilityRole="button" style={s.button} onPress={retry}><Text>전송 다시 시도</Text></Pressable>}
              </View>
            ))}
          </>}
          ListEmptyComponent={!pending.length && !error ? loading
            ? <ActivityIndicator accessibilityLabel="인증서 불러오는 중" />
            : <Text style={s.detail}>아직 촬영한 인증서가 없어요.</Text> : null}
          ListFooterComponent={more ? <Pressable accessibilityRole="button" disabled={loading || loadingMore} style={s.button} onPress={() => void earlier()}>
            <Text>{loadingMore ? "불러오는 중…" : "이전 인증서 보기"}</Text>
          </Pressable> : null}
          renderItem={({ item }) => (
            <View style={s.entry}>
              <Text style={s.name}>{item.mediaKind === "photo" ? "사진" : "영상"} · {certificateLabel[item.status]}</Text>
              <Text style={s.detail}>{new Date(item.createdAt).toLocaleString("ko-KR")} · {item.shared ? "링크 공유 중" : "비공개"}</Text>
              {item.status !== "uploading" && <View style={s.actions}>
                <Pressable accessibilityRole="button" disabled={!!acting} style={({ pressed }) => [s.primary, pressed && s.pressed]} onPress={() => void updateShare(item, false)}>
                  <Text style={s.primaryText}>{acting === item.id ? "처리 중…" : "인증서 공유"}</Text>
                </Pressable>
                {item.shared && <Pressable accessibilityRole="button" disabled={!!acting} style={s.button} onPress={() => void updateShare(item, true)}><Text>링크 끄기</Text></Pressable>}
              </View>}
            </View>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fafbf8" },
  header: { paddingHorizontal: 20, paddingVertical: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 22, fontWeight: "800", color: "#20221d" },
  list: { paddingHorizontal: 20, paddingBottom: 32 },
  entry: { paddingVertical: 16, gap: 6, borderBottomWidth: 1, borderColor: "#d9ddd0", alignItems: "flex-start" },
  name: { color: "#20221d", fontWeight: "700", fontSize: 17 },
  detail: { color: "#5e6559", fontSize: 14 },
  error: { color: "#ae3725", fontSize: 14 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  button: { minHeight: 48, paddingHorizontal: 12, justifyContent: "center" },
  primary: { minHeight: 48, paddingHorizontal: 16, justifyContent: "center", backgroundColor: "#20221d", borderRadius: 10 },
  primaryText: { color: "#d4ff3f", fontWeight: "700" },
  pressed: { opacity: 0.7 },
});
