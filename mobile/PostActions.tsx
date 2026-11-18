import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { postShareUrl, setOwnPostShare } from "../shared/post-share";
import type { Post } from "../shared/types";
import { supabase } from "./lib/supabase";

type Reaction = "likes" | "bookmarks";
type Action = Reaction | "share";
type LinkState = "inactive" | "active" | "unknown";

export default function PostActions({ post, userId, currentUser, manage, react, comment }: {
  post: Post;
  userId: string;
  currentUser: () => string | null;
  manage: boolean;
  react: (table: Reaction) => Promise<void>;
  comment: () => void;
}) {
  const owner = userId === post.user_id && !post.sample;
  const [linkState, setLinkState] = useState<LinkState>("inactive");
  const [notice, setNotice] = useState("");
  const locks = useRef(new Set<Action>());
  const [pending, setPending] = useState(new Set<Action>());
  const mounted = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!supabase || !owner || !manage) return;
    let active = true;
    const version = revision.current;
    const update = (state: LinkState) => {
      if (active && revision.current === version) setLinkState(state);
    };
    void Promise.resolve(supabase.rpc("has_own_post_share_link", { p_post: post.id }))
      .then(({ data, error }) => update(error ? "unknown" : data === true ? "active" : "inactive"))
      .catch(() => update("unknown"));
    return () => { active = false; };
  }, [post.id, owner, manage]);

  const current = () => mounted.current && currentUser() === userId;
  async function run(action: Action, work: () => Promise<void>, failure: string) {
    if (!current() || locks.current.has(action)) return;
    locks.current.add(action);
    setPending(new Set(locks.current));
    setNotice("");
    try {
      await work();
    } catch {
      if (current()) setNotice(failure);
    } finally {
      locks.current.delete(action);
      if (current()) setPending(new Set(locks.current));
    }
  }
  function changeLink(enabled: boolean) {
    const client = supabase;
    if (!client || !owner) return;
    void run("share", async () => {
      const token = await setOwnPostShare(client, post.id, enabled);
      if (!current()) return;
      ++revision.current;
      setLinkState(enabled ? "active" : "inactive");
      if (token) {
        const url = postShareUrl(token);
        await Share.share(Platform.OS === "ios" ? { url } : { message: url });
      } else {
        setNotice("공유 링크를 끊었어요.");
      }
    }, enabled ? "공유하지 못했어요. 다시 시도해 주세요." : "링크를 끊지 못했어요. 다시 시도해 주세요.");
  }
  const saving = pending.has("bookmarks");
  const sharing = pending.has("share");
  return <>
    <View style={s.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="좋아요"
        accessibilityState={{ selected: post.liked, busy: pending.has("likes") }}
        disabled={pending.has("likes")} style={button}
        onPress={() => void run("likes", () => react("likes"), "좋아요를 변경하지 못했어요. 다시 시도해 주세요.")}>
        <Text style={[s.bold, post.liked && s.liked]}>{post.liked ? "♥" : "♡"} {post.like_count}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={button} onPress={comment}>
        <Text>댓글 {post.comment_count}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={post.saved ? "저장 취소" : "게시물 저장"}
        accessibilityState={{ selected: post.saved, busy: saving }} disabled={saving} style={button}
        onPress={() => void run("bookmarks", () => react("bookmarks"), "저장 상태를 변경하지 못했어요. 다시 시도해 주세요.")}>
        {saving ? <ActivityIndicator /> : <Text style={post.saved ? s.bold : s.text}>{post.saved ? "저장됨 ✓" : "저장"}</Text>}
      </Pressable>
      {owner && <Pressable accessibilityRole="button" accessibilityLabel="공개 링크로 게시물 공유"
        accessibilityState={{ busy: sharing }} disabled={sharing} style={button} onPress={() => changeLink(true)}>
        {sharing ? <ActivityIndicator /> : <Text style={s.text}>공개 링크 공유</Text>}
      </Pressable>}
    </View>
    {owner && linkState !== "inactive" && (
      <Pressable accessibilityRole="button" disabled={sharing} style={({ pressed }) => [s.revoke, pressed && s.pressed]}
        onPress={() => changeLink(false)}>
        <Text style={s.text}>공유 링크 끊기</Text>
      </Pressable>
    )}
    {!!notice && <Text accessibilityRole="alert" style={s.notice}>{notice}</Text>}
  </>;
}

const s = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginTop: 5 },
  button: { minWidth: 48, minHeight: 48, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  revoke: { alignSelf: "flex-start", minHeight: 48, paddingHorizontal: 10, justifyContent: "center" },
  pressed: { opacity: 0.6 },
  text: { color: "#50554b" },
  bold: { fontWeight: "700", color: "#20221d" },
  liked: { color: "#c34242" },
  notice: { fontSize: 14, lineHeight: 22, color: "#50554b" },
});
const button = ({ pressed }: { pressed: boolean }) => [s.button, pressed && s.pressed];
