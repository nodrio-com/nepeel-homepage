import { useState } from "react";
import {
  Camera,
  Check,
  ChevronRight,
  Film,
  Image as ImageIcon,
} from "lucide-react";
import { Dialog, readableError } from "../App";
import { supabase } from "../lib/supabase";
import { mobileCameraDevice } from "../lib/app-camera";
import { updateProfile } from "../../shared/data";
import type { Post, Profile } from "../../shared/types";
import { reportPost, reportReasons } from "../../shared/account";
import "./utility-screens.css";

export { AuthDialog } from "./AuthDialog";
function CertificateExamples() {
  return (
    <div className="certificate-example-links">
      <a href="/verify/example-photo"><ImageIcon aria-hidden="true" /><span>사진 인증서 예시</span><ChevronRight aria-hidden="true" /></a>
      <a href="/verify/example-video"><Film aria-hidden="true" /><span>동영상 인증서 예시</span><ChevronRight aria-hidden="true" /></a>
    </div>
  );
}

export function CameraDialog({ close }: { close: () => void }) {
  const mobileDevice = mobileCameraDevice();
  return (
    <Dialog title="앱 카메라" close={close}>
      <div className="camera-availability">
        <p>촬영하려면 휴대전화에 nepeel 테스트 앱이 필요해요.</p>
        {mobileDevice && <a className="dark-button" href="nepeel://camera">
          <Camera size={17} aria-hidden="true" />앱 다시 열기
        </a>}
        <CertificateExamples />
      </div>
    </Dialog>
  );
}
export function EditProfile({
  profile,
  close,
  saved,
}: {
  profile: Profile;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const [bio, setBio] = useState(profile.bio);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog title="프로필 수정" close={close}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending || !name.trim()) return;
          setPending(true);
          try {
            await updateProfile(supabase!, profile.id, name, bio);
            saved();
          } catch (e) {
            setError(readableError(e));
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          이름
          <input
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          소개
          <textarea
            rows={3}
            maxLength={160}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
        </label>
        <small>{bio.length} / 160</small>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="dark-button full" disabled={pending || !name.trim()}>
          저장하기 <Check size={17} />
        </button>
      </form>
    </Dialog>
  );
}
export { Recovery } from "./Recovery";
export { PostDialog } from "./MediaViewer";
export function ReportDialog({
  post,
  userId,
  close,
  done,
}: {
  post: Post;
  userId: string;
  close: () => void;
  done: () => void;
}) {
  const [reason, setReason] = useState("synthetic");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Dialog title="게시물 신고" close={close}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending) return;
          setPending(true);
          try {
            await reportPost(supabase!, userId, post.id, reason);
            done();
          } catch {
            setError("연결을 확인해 주세요.");
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          신고 이유
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reportReasons.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="dark-button" disabled={pending}>
          신고 접수
        </button>
      </form>
    </Dialog>
  );
}
export function About({ onCamera }: { onCamera: () => void }) {
  return (
    <section className="service-info">
      <header className="page-heading"><h1>서비스 소개</h1></header>
      <section>
        <h2>사진 게시</h2>
        <p>nepeel 피드에는 앱 카메라로 직접 찍은 사진을 게시해요. 웹에서는 회원의 사진을 보고, 댓글을 달거나 저장할 수 있어요.</p>
        <button className="service-link" onClick={onCamera}><Camera size={17} />앱에서 촬영<ChevronRight size={16} /></button>
      </section>
      <section>
        <h2>촬영 인증</h2>
        <p>‘앱 촬영’ 표시는 서버가 앱·기기 인증 정보와 촬영 파일의 일치를 확인했다는 뜻이에요. 화면을 다시 찍었는지, 장면에 생성 이미지가 있는지는 판별할 수 없어요.</p>
        <CertificateExamples />
      </section>
      <section>
        <h2>공개 미리보기</h2>
        <p>로그인 전 피드에서는 출처가 표시된 예시 사진과 동영상을 볼 수 있어요. 회원 게시물은 로그인 후 볼 수 있어요.</p>
      </section>
    </section>
  );
}
