import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CommentDrafts } from "./commentDrafts";
import { createComment, getCommentPage } from "./comments";
import type { CommentCursor } from "./comments";
import type { Comment } from "./types";

interface Options { client: SupabaseClient | null; userId?: string; postId: string; enabled: boolean; makeId: () => string; drafts?: CommentDrafts }
interface State {
  key: string; comments: Comment[]; loading: boolean; loadingMore: boolean;
  hasMore: boolean; loadError: boolean; moreError: boolean;
}
const empty = (key: string): State => ({ key, comments: [], loading: false, loadingMore: false,
  hasMore: false, loadError: false, moreError: false });
interface RequestScope {
  key: string; reading: boolean; more: boolean; cursor: CommentCursor | null;
}

export function useComments({ client, userId, postId, enabled, makeId, drafts }: Options) {
  const key = JSON.stringify([userId, postId, enabled]);
  const store = useMemo(() => drafts && drafts.owner === userId ? drafts : new CommentDrafts(userId), [drafts, userId]);
  const draftPost = client && userId && enabled ? postId : null;
  const readDraft = () => store.read(draftPost);
  const draft = useSyncExternalStore(store.subscribe, readDraft, readDraft);
  const [state, setState] = useState(() => empty(key));
  const scope = useRef<RequestScope | null>(null);
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const current: RequestScope = { key, reading: !!draftPost, more: false, cursor: null };
    scope.current = current;
    const valid = () => scope.current === current;
    const cleanup = () => { if (valid()) scope.current = null; };
    if (!client || !draftPost) { setState(empty(key)); return cleanup; }
    setState({ ...empty(key), loading: true });
    const pending = store.read(draftPost).pending;
    async function load(client: SupabaseClient) {
      // A viewer reopened during a send should load the resulting server state.
      if (pending) await pending.catch(() => undefined);
      if (!valid()) return;
      try {
        const page = await getCommentPage(client, postId);
        if (!valid()) return;
        current.cursor = page.cursor; current.more = page.hasMore;
        setState(old => ({ ...old, comments: page.comments, hasMore: page.hasMore, loading: false }));
      } catch { if (valid()) setState(old => ({ ...old, loadError: true, loading: false })); }
      finally { current.reading = false; }
    }
    void load(client);
    return cleanup;
  }, [client, key, postId, draftPost, store, retry]);

  const setBody = useCallback((body: string) => {
    if (draftPost && scope.current?.key === key) store.edit(draftPost, body);
  }, [draftPost, key, store]);

  const loadMore = useCallback(async () => {
    const current = scope.current;
    if (!client || !current || current.key !== key || current.reading || !current.more) return;
    current.reading = true;
    const valid = () => scope.current === current;
    setState(old => ({ ...old, loadingMore: true, moreError: false }));
    try {
      const page = await getCommentPage(client, postId, current.cursor);
      if (!valid()) return;
      current.cursor = page.cursor; current.more = page.hasMore;
      setState(old => {
        const known = new Set(old.comments.map(comment => comment.id));
        return { ...old, comments: [...old.comments, ...page.comments.filter(comment => !known.has(comment.id))], hasMore: page.hasMore };
      });
    } catch { if (valid()) setState(old => ({ ...old, moreError: true })); }
    finally {
      if (valid()) { current.reading = false; setState(old => ({ ...old, loadingMore: false })); }
    }
  }, [client, key, postId]);

  const submit = useCallback(async (): Promise<boolean> => {
    const current = scope.current;
    if (!client || !userId || !draftPost || !current || current.key !== key || (current.reading && !current.cursor)) return false;
    try {
      const pending = store.submit(draftPost, makeId, (id, body) => createComment(client, userId, draftPost, id, body));
      if (!pending) return false;
      const comment = await pending;
      if (scope.current !== current) return false;
      setState(old => ({ ...old, comments: [comment, ...old.comments.filter(item => item.id !== comment.id)] }));
      return true;
    } catch { return false; }
  }, [client, userId, draftPost, key, makeId, store]);

  const visible = state.key === key ? state : { ...empty(key), loading: !!client && !!userId && enabled };
  const reload = () => {
    const current = scope.current;
    if (current?.key === key && !store.read(draftPost).pending && !current.reading)
      setRetry(value => value + 1);
  };
  return { ...visible, body: draft.body, posting: !!draft.pending, postError: draft.postError, setBody, loadMore, submit, reload };
}
