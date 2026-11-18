import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Linking,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  captureApi,
  CaptureApiError,
  discardPhoto,
  prepareCamera,
  prepareCaptureRequest,
  withAttestation,
  type CertificateReceipt,
  type MediaKind,
} from "./lib/capture";
import { CAPTURE_CERT_MAX_BYTES, CAPTURE_CERT_VIDEO_SECONDS } from "../shared/media-certificate";
import { observeCertificates, saveCapture, shareCertificate } from "./lib/certificates";
import CertificateHistory, { certificateLabel } from "./CertificateHistory";
import type { Challenge } from "../shared/types";
import { CaptureSubmission } from "../shared/capture-submission";
import {
  PHOTO_FILTERS,
  type CaptureContext,
  type PhotoFilter,
  type PlaceAudience,
} from "../shared/capture-context";
import {
  CaptureLocationConsent,
  newPhotoCaptureContext,
} from "../shared/capture-location-consent";
import { audienceLabel, type NearbyPhoto } from "../shared/places";
import { currentPlace } from "./lib/location";
import FilteredPhoto from "./FilteredPhoto";

export default function CameraScreen({
  userId,
  done,
  close,
  reference = null,
  cameraLink,
}: {
  userId: string;
  done: () => void;
  close: () => void;
  reference?: NearbyPhoto | null;
  cameraLink: number;
}) {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const prompted = useRef(false);
  const requestingPermission = useRef(false);
  const [permissionError, setPermissionError] = useState("");
  const camera = useRef<CameraView>(null);
  const uriRef = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const keyRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const submission = useRef<CaptureSubmission | null>(null);
  const locationConsent = useRef(new CaptureLocationConsent());
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [kind, setKind] = useState<MediaKind>("photo");
  const [recordingAt, setRecordingAt] = useState<number | null>(null);
  const recordingView = useRef<CameraView | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [history, setHistory] = useState(false);
  const [postOptions, setPostOptions] = useState(false);
  const [receipt, setReceipt] = useState<CertificateReceipt | null>(null);
  const [lastId, setLastId] = useState("");
  const [certError, setCertError] = useState("");
  const lastIdRef = useRef("");
  const sharing = useRef(false);
  const [shareBusy, setShareBusy] = useState(false);
  const tickets = useRef<{ private?: Promise<Challenge>; social?: Promise<Challenge> }>({});
  const [armed, setArmed] = useState<{ kind: MediaKind; certificate: Challenge; social: Challenge | null } | null>(null);
  const [armingError, setArmingError] = useState("");
  const [armRevision, setArmRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  const [photo, setPhoto] = useState<{
    uri: string;
    challenge: Challenge | null;
  } | null>(null);
  const [size, setSize] = useState<string>();
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(180);
  const [context, setContext] = useState<CaptureContext>(() =>
    newPhotoCaptureContext(reference?.post_id ?? null),
  );
  const [locked, setLocked] = useState(false);
  const [prepared, setPrepared] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [overlay, setOverlay] = useState(0.35);
  useEffect(() => { setHistory(false); }, [cameraLink]);
  const askForCamera = useCallback(async () => {
    if (requestingPermission.current) return;
    requestingPermission.current = true;
    setPermissionError("");
    try {
      const result = await requestPermission();
      if (mounted.current && result.status === "undetermined")
        setPermissionError("카메라 권한을 확인하지 못했어요.");
    } catch {
      if (mounted.current) setPermissionError("카메라 권한을 확인하지 못했어요.");
    } finally {
      requestingPermission.current = false;
    }
  }, [requestPermission]);
  useEffect(() => {
    if (!active || prompted.current || permission?.status !== "undetermined") return;
    prompted.current = true;
    void askForCamera();
  }, [active, permission?.status, askForCamera]);
  function reserve(use: "private" | "social") {
    if (!tickets.current[use]) {
      const pending = captureApi<Challenge>({ action: "challenge", purpose: use === "private" ? "certify" : "capture" }, userId);
      tickets.current[use] = pending;
      void pending.catch(() => {
        if (tickets.current[use] === pending) delete tickets.current[use];
      });
    }
    return tickets.current[use]!;
  }
  async function freshTicket(use: "private" | "social") {
    const pending = reserve(use);
    const ticket = await pending;
    // Leave enough time for the native recording, proof and first network request.
    if (Date.parse(ticket.expires_at) - Date.now() <= (CAPTURE_CERT_VIDEO_SECONDS + 30) * 1000) {
      if (tickets.current[use] === pending) delete tickets.current[use];
      return reserve(use);
    }
    return ticket;
  }
  useEffect(() => {
    setArmed(null);
    setArmingError("");
    if (!active || !permission?.granted || photo || history || pendingRef.current) return;
    let current = true;
    let expiry: ReturnType<typeof setTimeout>;
    void prepareCamera(userId).then(async key => {
      if (!current) return;
      keyRef.current = key;
      const [certificate, social] = await Promise.all([
        freshTicket("private"),
        kind === "photo" ? freshTicket("social").catch(() => null) : null,
      ]);
      if (!current) return;
      setArmed({ kind, certificate, social });
      const expires = Math.min(Date.parse(certificate.expires_at), social ? Date.parse(social.expires_at) : Infinity);
      expiry = setTimeout(() => setArmRevision(n => n + 1), Math.max(1000, expires - Date.now() - (CAPTURE_CERT_VIDEO_SECONDS + 30) * 1000));
    }).catch(e => {
      if (current) setArmingError(e instanceof Error ? e.message : "촬영 인증을 준비하지 못했어요.");
    });
    return () => { current = false; clearTimeout(expiry); };
  }, [active, permission?.granted, photo, history, kind, userId, armRevision]);
  useEffect(() => observeCertificates(event => {
    if (event.owner !== userId || event.challengeId !== lastIdRef.current) return;
    if (event.receipt) setReceipt(event.receipt);
    if (event.error) setCertError(event.error);
  }), [userId]);
  useEffect(() => {
    if (recordingAt === null) return;
    const timer = setInterval(() => setSeconds(Math.min(CAPTURE_CERT_VIDEO_SECONDS, Math.floor((Date.now() - recordingAt) / 1000))), 250);
    return () => clearInterval(timer);
  }, [recordingAt]);
  async function locate() {
    if (
      !photo ||
      submission.current ||
      pendingRef.current ||
      locating ||
      AppState.currentState !== "active"
    )
      return;
    const request = locationConsent.current.request(
      photo.uri,
      context.place?.audience ?? "followers",
    );
    if (!request) return;
    const isCurrent = () =>
      mounted.current &&
      locationConsent.current.accepts(request) &&
      !submission.current;
    setLocating(true);
    setLocationError("");
    try {
      const place = await currentPlace(request.audience, true, isCurrent);
      if (isCurrent() && AppState.currentState === "active")
        setContext((old) => ({ ...old, place }));
    } catch (e) {
      if (isCurrent())
        setLocationError(
          e instanceof Error ? e.message : "위치를 확인하지 못했어요.",
        );
    } finally {
      if (isCurrent()) setLocating(false);
    }
  }
  function removePlace() {
    if (submission.current) return;
    locationConsent.current.cancel();
    setLocating(false);
    setLocationError("");
    setContext((old) => ({ ...old, place: null }));
  }
  const reset = () => {
    generation.current++;
    discardPhoto(uriRef.current);
    uriRef.current = undefined;
    setPhoto(null);
    setPostOptions(false);
    setCaption("");
    setError("");
    setReady(false);
    submission.current = null;
    setLocked(false);
    setPrepared(false);
    setTerminal(false);
    locationConsent.current.startPhoto(null);
    removePlace();
    setContext(newPhotoCaptureContext(reference?.post_id ?? null));
  };
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
      if (state === "active" && !requestingPermission.current) {
        void getPermission().catch(() => {
          if (mounted.current) setPermissionError("카메라 권한을 확인하지 못했어요.");
        });
      }
      if (state !== "active") {
        recordingView.current?.stopRecording();
        setReady(false);
        // Pause live capture; preserve the photographed draft and prepared upload.
        generation.current++;
      }
      if (state === "background") {
        locationConsent.current.cancel();
        setLocating(false);
      }
    });
    return () => {
      generation.current++;
      mounted.current = false;
      locationConsent.current.startPhoto(null);
      listener.remove();
      discardPhoto(uriRef.current);
    };
  }, [getPermission]);
  useEffect(() => {
    const challenge = photo?.challenge;
    if (!challenge) return;
    const update = () =>
      setRemaining(
        Math.max(
          0,
          Math.ceil(
            (Date.parse(challenge.expires_at) - Date.now()) / 1000,
          ),
        ),
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [photo]);
  async function capture() {
    if (
      !camera.current ||
      !ready ||
      armed?.kind !== kind ||
      !tickets.current.private ||
      pendingRef.current ||
      AppState.currentState !== "active"
    )
      return;
    if (Date.parse(armed.certificate.expires_at) <= Date.now() + CAPTURE_CERT_VIDEO_SECONDS * 1000) {
      setArmRevision(n => n + 1);
      return;
    }
    const { certificate, social } = armed;
    setArmed(null);
    delete tickets.current.private;
    if (kind === "photo") delete tickets.current.social;
    pendingRef.current = true;
    setError("");
    try {
      const view = camera.current;
      if (!view) return;
      let result: { uri: string } | undefined;
      if (kind === "video") {
        recordingView.current = view;
        setSeconds(0);
        setRecordingAt(Date.now());
        setStatus("녹화 중");
        result = await view.recordAsync({
          maxDuration: CAPTURE_CERT_VIDEO_SECONDS,
          maxFileSize: CAPTURE_CERT_MAX_BYTES - 65_536,
          codec: "avc1",
        });
        recordingView.current = null;
        if (mounted.current) setRecordingAt(null);
      } else {
        setStatus("사진 촬영 중…");
        result = await view.takePictureAsync({ quality: 0.65, exif: false, skipProcessing: false });
      }
      if (!result) throw new Error("다시 촬영해 주세요.");
      // A file finalized while moving to the background still belongs to the
      // shutter press that started it. Account changes unmount this screen.
      if (!mounted.current) {
        discardPhoto(result.uri);
        return;
      }
      setStatus("비공개 원본 저장 중…");
      lastIdRef.current = certificate.id;
      setLastId("");
      setCertError("");
      setReceipt(null);
      try {
        await saveCapture(userId, certificate, kind, result.uri);
      } catch (e) {
        discardPhoto(result.uri);
        throw e;
      }
      if (kind === "video" || !mounted.current) discardPhoto(result.uri);
      if (!mounted.current) return;
      setLastId(certificate.id);
      if (kind === "video") return;
      uriRef.current = result.uri;
      locationConsent.current.startPhoto(result.uri);
      setContext(newPhotoCaptureContext(reference?.post_id ?? null));
      setLocationError("");
      setPhoto({ uri: result.uri, challenge: social });
      setRemaining(180);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "촬영을 시작하지 못했어요.");
    } finally {
      recordingView.current = null;
      pendingRef.current = false;
      if (mounted.current) { setRecordingAt(null); setStatus(""); setArmRevision(n => n + 1); }
    }
  }
  async function publish() {
    if (
      !photo?.challenge ||
      pendingRef.current ||
      locating ||
      terminal ||
      (!prepared && remaining <= 0)
    )
      return;
    pendingRef.current = true;
    setStatus("촬영 확인 후 게시하는 중…");
    setError("");
    setLocked(true);
    try {
      const challenge = photo.challenge;
      if (!submission.current)
        submission.current = new CaptureSubmission(
          () =>
            prepareCaptureRequest(
              userId,
              challenge,
              photo.uri,
              caption,
              keyRef.current,
              context,
            ),
          (request) => captureApi<{ id: string }>(request, userId),
        );
      const draft = submission.current;
      await withAttestation(() => draft.submit());
      discardPhoto(photo.uri);
      uriRef.current = undefined;
      if (mounted.current) done();
    } catch (e) {
      if (mounted.current) {
        setPrepared(!!submission.current?.prepared);
        if (!submission.current?.prepared) {
          submission.current = null;
          setLocked(false);
        }
        if (
          e instanceof CaptureApiError &&
          [400, 403, 409, 410].includes(e.status)
        )
          setTerminal(true);
        setError(e instanceof Error ? e.message : "게시를 완료하지 못했어요.");
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setStatus("");
    }
  }
  async function shareLast() {
    if (!receipt || sharing.current) return;
    sharing.current = true;
    setShareBusy(true);
    setError("");
    try {
      await shareCertificate(userId, receipt.id, () => mounted.current);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "인증서를 공유하지 못했어요.");
    } finally {
      sharing.current = false;
      if (mounted.current) setShareBusy(false);
    }
  }
  const receiptControls = !!lastId && (
    <View style={s.receipt}>
      <Text style={s.sectionTitle} accessibilityLiveRegion="polite">
        {certError ? "인증 실패" : receipt ? certificateLabel[receipt.status] : "비공개 인증서 전송 대기"}
      </Text>
      {!!certError && <Text style={s.error}>{certError}</Text>}
      <View style={s.receiptActions}>
        {receipt && <Pressable accessibilityRole="button" disabled={shareBusy} style={s.primary} onPress={() => void shareLast()}>
          <Text style={s.primaryText}>{shareBusy ? "공유 준비 중…" : "인증서 공유"}</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" disabled={!!status || shareBusy} style={s.button} onPress={() => { setReady(false); setHistory(true); }}><Text>내 인증서 보기</Text></Pressable>
      </View>
    </View>
  );
  if (!permission || (permission.status === "undetermined" && !permissionError))
    return (
      <View style={s.center}>
        <ActivityIndicator />
      </View>
    );
  if (!permission.granted)
    return (
      <View style={s.permission}>
        <Text style={s.title}>{permissionError || "촬영하려면 카메라 권한이 필요해요."}</Text>
        <Pressable
          accessibilityRole="button"
          style={s.primary}
          onPress={() =>
            permission.canAskAgain
              ? void askForCamera()
              : void Linking.openSettings().catch(() => setPermissionError("기기 설정에서 카메라 권한을 허용해 주세요."))
          }
        >
          <Text style={s.primaryText}>
            {permission.canAskAgain
              ? "카메라 접근 허용"
              : "설정에서 카메라 허용"}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={s.button} onPress={close}>
          <Text>돌아가기</Text>
        </Pressable>
      </View>
    );
  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={s.header}>
        <Pressable
          accessibilityLabel="촬영 닫기"
          disabled={!!status}
          onPress={close}
          style={s.button}
        >
          <Text>닫기</Text>
        </Pressable>
        <Text style={s.logo}>nepeel / camera</Text>
        <Pressable
          disabled={!!status || !!photo}
          onPress={() => {
            generation.current++;
            setReady(false);
            setSize(undefined);
            setFacing((v) => (v === "back" ? "front" : "back"));
          }}
          style={s.button}
        >
          <Text>전환</Text>
        </Pressable>
      </View>
      <View style={s.camera}>
        {photo ? (
          <FilteredPhoto uri={photo.uri} filter={context.filter} />
        ) : active && !history ? (
          <CameraView
            key={`${kind}-${facing}`}
            ref={camera}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode={kind === "video" ? "video" : "picture"}
            mute
            videoQuality="480p"
            videoBitrate={800_000}
            pictureSize={kind === "photo" ? size : undefined}
            onMountError={() =>
              setError("카메라를 열지 못했어요. 권한을 확인해 주세요.")
            }
            onCameraReady={async () => {
              const current = generation.current;
              try {
                const sizes = kind === "photo"
                  ? await camera.current?.getAvailablePictureSizesAsync() : [];
                const candidates = sizes
                  ?.filter((v) => /^\d+x\d+$/.test(v))
                  .map((v) => ({
                    value: v,
                    pixels: v
                      .split("x")
                      .map(Number)
                      .reduce((a, b) => a * b),
                  }))
                  .sort((a, b) => a.pixels - b.pixels);
                const choice = candidates?.filter(v => v.pixels <= 1_500_000).at(-1) ?? candidates?.[0];
                if (choice && current === generation.current) setSize(choice.value);
              } catch {
                /* Camera default remains available. */
              }
              if (
                current === generation.current &&
                AppState.currentState === "active"
              )
                setReady(true);
            }}
          />
        ) : (
          <View style={StyleSheet.absoluteFill} />
        )}
        {!photo && reference && (
          <>
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <Image
                source={{ uri: reference.image_url }}
                style={[StyleSheet.absoluteFill, { opacity: overlay }]}
                resizeMode="contain"
              />
              <View style={[s.gridHorizontal, { top: "33.33%" }]} />
              <View style={[s.gridHorizontal, { top: "66.66%" }]} />
              <View style={[s.gridVertical, { left: "33.33%" }]} />
              <View style={[s.gridVertical, { left: "66.66%" }]} />
            </View>
            <View style={s.referenceBar}>
              <Text style={s.referenceText}>
                {reference.display_name}님의 구도 참고
              </Text>
              <View style={s.referenceChoices}>
                {[0, 0.2, 0.35, 0.5].map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: overlay === value }}
                    accessibilityLabel={
                      value === 0
                        ? "참고 사진 숨기기"
                        : `참고 사진 ${Math.round(value * 100)}퍼센트`
                    }
                    style={[
                      s.overlayChoice,
                      overlay === value && s.filterSelected,
                    ]}
                    onPress={() => setOverlay(value)}
                  >
                    <Text style={s.overlayText}>
                      {value === 0 ? "숨김" : `${Math.round(value * 100)}%`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </>
        )}
      </View>
      <ScrollView
        style={s.reviewScroll}
        contentContainerStyle={s.controls}
        keyboardShouldPersistTaps="handled"
      >
        {photo ? (
          <>
            {receiptControls}
            <View style={s.row}>
              <Pressable accessibilityRole="button" style={s.secondary} disabled={!!status || shareBusy} onPress={reset}>
                <Text>다음 촬영</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: postOptions }}
                style={s.button} disabled={!!status}
                onPress={() => setPostOptions(value => !value)}>
                <Text>{postOptions ? "게시 설정 닫기" : "필터 · 설명 · 장소"}</Text>
              </Pressable>
            </View>
            {postOptions && <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.filters}
              contentContainerStyle={s.filterRow}
            >
              {(Object.keys(PHOTO_FILTERS) as PhotoFilter[]).map((filter) => (
                <Pressable
                  key={filter}
                  disabled={locked}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: context.filter === filter,
                    disabled: locked,
                  }}
                  onPress={() => setContext((old) => ({ ...old, filter }))}
                  style={[
                    s.filterChip,
                    context.filter === filter && s.filterSelected,
                  ]}
                >
                  <Text style={s.filterText}>
                    {PHOTO_FILTERS[filter].label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={s.input}
              placeholder="이 순간에 한마디"
              value={caption}
              onChangeText={setCaption}
              multiline
              maxLength={1000}
              editable={!locked}
              accessibilityLabel="사진 설명"
            />
            <View style={s.placeCard}>
              <Text style={s.sectionTitle}>촬영 장소 · 선택 사항</Text>
              <Text style={s.small}>
                이 사진에 장소를 추가하면 대략적인 촬영 위치가 표시돼요.
                친구의 현재 위치가 아니며, 게시 전 위치를 뺄 수 있어요.
              </Text>
              <Text style={s.small}>
                기본 공개 범위는 팔로워예요. 팔로워는 별도 승인 없이 나를
                팔로우한 모든 회원이며, 승인한 친구 목록이 아니에요.
              </Text>
              {context.place ? (
                <>
                  <TextInput
                    accessibilityLabel="촬영 장소 이름"
                    style={s.input}
                    value={context.place.label}
                    maxLength={80}
                    editable={!locked && !locating}
                    onChangeText={(label) =>
                      setContext((old) => ({
                        ...old,
                        place: old.place ? { ...old.place, label } : null,
                      }))
                    }
                  />
                  <View style={s.audiences}>
                    {(
                      ["private", "followers", "members"] as PlaceAudience[]
                    ).map((audience) => (
                      <Pressable
                        key={audience}
                        disabled={locked || locating}
                        accessibilityRole="radio"
                        accessibilityState={{
                          checked: context.place?.audience === audience,
                        }}
                        style={[
                          s.audience,
                          context.place?.audience === audience &&
                            s.filterSelected,
                        ]}
                        onPress={() =>
                          setContext((old) => ({
                            ...old,
                            place: old.place
                              ? { ...old.place, audience }
                              : null,
                          }))
                        }
                      >
                        <Text style={s.filterText}>
                          {audienceLabel[audience]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : (
                <Text style={s.muted}>
                  {locating
                    ? "촬영한 장소를 찾고 있어요…"
                    : "현재 이 사진에는 장소가 없어요. 장소 없이도 게시할 수 있어요."}
                </Text>
              )}
              <View style={s.row}>
                <Pressable
                  disabled={locked || locating}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: locked || locating, busy: locating }}
                  style={s.button}
                  onPress={() => void locate()}
                >
                  <Text>
                    {locating
                      ? "위치 확인 중…"
                      : context.place
                        ? "위치 다시 확인"
                        : "촬영 장소 사용"}
                  </Text>
                </Pressable>
                {(context.place || locating) && (
                  <Pressable
                    disabled={locked}
                    accessibilityRole="button"
                    style={s.button}
                    onPress={removePlace}
                  >
                    <Text>위치 빼기</Text>
                  </Pressable>
                )}
              </View>
              {!!locationError && (
                <Text style={s.error} accessibilityRole="alert">
                  {locationError}
                </Text>
              )}
            </View>
            </>}
            {(!photo.challenge || remaining <= 0 || prepared) && <Text style={s.muted}>
              {prepared ? "같은 사진과 설정으로 게시를 다시 시도할 수 있어요."
                : !photo.challenge ? "이 사진의 피드 게시를 준비하지 못했어요."
                : "피드 게시 시간이 지났어요. 새 사진을 촬영해 주세요."}
            </Text>}
            <View style={s.row}>
              <Pressable
                accessibilityRole="button"
                style={[
                  s.primary,
                  s.flex,
                  (!!status ||
                    locating ||
                    terminal || !photo.challenge ||
                    (!prepared && remaining <= 0)) &&
                    s.disabled,
                ]}
                disabled={
                  !!status ||
                  locating ||
                  terminal || !photo.challenge ||
                  (!prepared && remaining <= 0)
                }
                onPress={() => void publish()}
              >
                <Text style={s.primaryText}>
                  {prepared ? "다시 게시하기 ↗" : "피드에 게시 ↗"}
                </Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={s.receiptActions}>
              {(["photo", "video"] as const).map(next => (
                <Pressable
                  key={next}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: kind === next, disabled: !!status }}
                  disabled={!!status}
                  style={[s.filterChip, kind === next && s.filterSelected]}
                  onPress={() => {
                    if (kind === next || pendingRef.current) return;
                    generation.current++;
                    setReady(false);
                    setKind(next);
                    setError("");
                  }}
                ><Text style={s.filterText}>{next === "photo" ? "사진" : "영상"}</Text></Pressable>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={recordingAt !== null ? "녹화 중지" : kind === "photo" ? "사진 촬영" : "영상 녹화"}
              disabled={recordingAt === null && (!ready || armed?.kind !== kind || !!status)}
              style={[s.shutter, recordingAt === null && (!ready || armed?.kind !== kind || !!status) && s.disabled]}
              onPress={() => recordingAt === null ? void capture() : camera.current?.stopRecording()}
            >
              <View style={[s.shutterInner, recordingAt !== null && s.stop]} />
            </Pressable>
            {armingError ? <>
              <Text accessibilityRole="alert" style={s.error}>{armingError}</Text>
              <Pressable accessibilityRole="button" style={s.button} onPress={() => setArmRevision(n => n + 1)}><Text>촬영 준비 다시 시도</Text></Pressable>
            </> : <Text style={s.muted}>
              {recordingAt !== null ? `녹화 중 · ${seconds} / ${CAPTURE_CERT_VIDEO_SECONDS}초`
                : !armed && !status ? "촬영 인증 준비 중…"
                : kind === "video" ? `무음 · 최대 ${CAPTURE_CERT_VIDEO_SECONDS}초 · 비공개 인증` : "촬영하면 비공개로 인증돼요."}
            </Text>}
          </>
        )}
        {!photo && !status && receiptControls}
        {status && recordingAt === null ? (
          <View style={s.row}>
            <ActivityIndicator />
            <Text style={s.muted}>{status}</Text>
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={s.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      {history && <CertificateHistory userId={userId} close={() => setHistory(false)} />}
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fafbf8" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 8,
  },
  logo: { fontSize: 17, fontWeight: "800", letterSpacing: -0.7 },
  button: { padding: 13, minHeight: 48, justifyContent: "center" },
  camera: { flex: 1, backgroundColor: "#20221d" },
  reviewScroll: { flexGrow: 0, maxHeight: "55%" },
  controls: { padding: 22, gap: 16, alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, width: "100%" },
  input: {
    borderWidth: 1,
    borderColor: "#d9ddd0",
    borderRadius: 10,
    padding: 14,
    width: "100%",
    maxHeight: 110,
    minHeight: 54,
    fontSize: 15,
  },
  primary: {
    backgroundColor: "#20221d",
    padding: 16,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryText: { color: "#d4ff3f", fontWeight: "700" },
  secondary: {
    padding: 16,
    borderWidth: 1,
    borderColor: "#d9ddd0",
    borderRadius: 10,
  },
  flex: { flex: 1 },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 2,
    borderColor: "#20221d",
    padding: 5,
  },
  shutterInner: { flex: 1, backgroundColor: "#d4ff3f", borderRadius: 33 },
  stop: { borderRadius: 4, margin: 13, backgroundColor: "#ae3725" },
  receipt: { width: "100%", gap: 8, alignItems: "center" },
  receiptActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 8 },
  muted: { fontSize: 13, color: "#6d7463", lineHeight: 22 },
  small: { fontSize: 11, color: "#707369" },
  disabled: { opacity: 0.4 },
  error: { color: "#ae3725", fontSize: 12, lineHeight: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  permission: { flex: 1, padding: 30, justifyContent: "center", gap: 22 },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -1 },
  filters: { width: "100%", flexGrow: 0 },
  filterRow: { gap: 8 },
  filterChip: {
    minHeight: 48,
    minWidth: 60,
    padding: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d9ddd0",
    borderRadius: 24,
  },
  filterSelected: { backgroundColor: "#d4ff3f", borderColor: "#20221d" },
  filterText: { fontSize: 13, fontWeight: "700", color: "#20221d" },
  placeCard: {
    width: "100%",
    gap: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#f0f2eb",
  },
  sectionTitle: { fontSize: 15, fontWeight: "700" },
  audiences: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  audience: {
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderColor: "#d9ddd0",
    borderRadius: 12,
    justifyContent: "center",
  },
  gridHorizontal: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "#ffffff70",
  },
  gridVertical: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "#ffffff70",
  },
  referenceBar: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    gap: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "#20221de6",
  },
  referenceText: { color: "white", fontSize: 13, fontWeight: "700" },
  referenceChoices: { flexDirection: "row", gap: 8 },
  overlayChoice: {
    minWidth: 48,
    minHeight: 48,
    padding: 8,
    borderRadius: 10,
    backgroundColor: "#fafbf8",
    justifyContent: "center",
    alignItems: "center",
  },
  overlayText: { color: "#20221d", fontSize: 12 },
});
