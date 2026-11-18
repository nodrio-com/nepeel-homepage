import type { Comment } from "./types";

interface Draft {
  body: string;
  attempts?: readonly { id: string; body: string }[];
  pending?: Promise<Comment>;
  postError: boolean;
}

const empty: Draft = { body: "", postError: false };
const maxDrafts = 32;
const maxAttemptsPerDraft = 16;

// The owning session supplies this store to each viewer it opens.
export class CommentDrafts {
  readonly owner?: string;
  private posts = new Map<string, Draft>();
  private listeners = new Set<() => void>();

  constructor(owner?: string) {
    this.owner = owner;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  read(postId: string | null): Readonly<Draft> {
    return postId ? this.posts.get(postId) ?? empty : empty;
  }

  private write(postId: string, draft: Draft) {
    this.posts.delete(postId);
    if (draft !== empty) {
      if (this.posts.size >= maxDrafts) {
        // Prefer an ordinary draft over one awaiting confirmation from the server.
        const entries = [...this.posts];
        const oldest = entries.find(([, item]) => !item.attempts) ??
          entries.find(([, item]) => !item.pending) ?? entries[0];
        this.posts.delete(oldest[0]);
      }
      this.posts.set(postId, draft);
    }
    for (const listener of this.listeners) listener();
  }

  edit(postId: string, body: string) {
    const draft = this.read(postId);
    if (!this.owner || draft.pending || body === draft.body) return;
    this.write(postId, !body && !draft.attempts ? empty : { ...draft, body, postError: false });
  }

  submit(postId: string, makeId: () => string, send: (id: string, body: string) => Promise<Comment>) {
    const draft = this.read(postId);
    const body = draft.body.trim();
    if (!this.owner || draft.pending || !body) return;
    const previous = draft.attempts ?? [];
    let id: string;
    try {
      id = previous.find(attempt => attempt.body === body)?.id ?? makeId();
    } catch (error) {
      this.write(postId, { ...draft, postError: true });
      return Promise.reject(error);
    }
    const attempts = [...previous.filter(attempt => attempt.id !== id), { id, body }].slice(-maxAttemptsPerDraft);
    const pending = Promise.resolve().then(() => send(id, body)).then(comment => {
      if (this.read(postId).pending === pending) this.write(postId, empty);
      return comment;
    }, error => {
      if (this.read(postId).pending === pending)
        this.write(postId, { body: draft.body, attempts, postError: true });
      throw error;
    });
    this.write(postId, { body: draft.body, attempts, pending, postError: false });
    return pending;
  }
}
