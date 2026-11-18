import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { CAPTURE_CERT_MAX_BYTES, CAPTURE_CERT_VIDEO_SECONDS } from "../shared/media-certificate.js";
import { ApiError } from "./validation.js";

const run = promisify(execFile);
const maxSeconds = CAPTURE_CERT_VIDEO_SECONDS + 1; // Allow the camera to finish writing its last frames.
const fps = 24;
const invalidVideo = () => new ApiError(400, "짧은 카메라 동영상을 확인할 수 없습니다. 다시 촬영해 주세요.");

// Check the movie timescale and duration before decoding and again on the
// newly encoded MP4. Never authorize a file just from its container header.
function movieDuration(file: Buffer) {
  function* boxes(start: number, end: number) {
    let count = 0;
    while (start < end) {
      if (++count > 4096 || end - start < 8) throw invalidVideo();
      const type = file.toString("latin1", start + 4, start + 8);
      let size = file.readUInt32BE(start);
      let header = 8;
      if (size === 1) {
        if (end - start < 16) throw invalidVideo();
        size = Number(file.readBigUInt64BE(start + 8));
        header = 16;
      } else if (size === 0) {
        size = end - start;
      }
      if (size < header || size > end - start) throw invalidVideo();
      yield { type, start: start + header, end: start + size };
      start += size;
    }
  }

  let duration = 0;
  let hasMedia = false;
  let movieCount = 0;
  for (const box of boxes(0, file.length)) {
    if (box.type === "mdat" && box.end > box.start) hasMedia = true;
    if (box.type !== "moov") continue;
    if (++movieCount !== 1) throw invalidVideo();
    for (const child of boxes(box.start, box.end)) {
      if (child.type !== "mvhd") continue;
      const version = file[child.start];
      const timescaleAt = child.start + (version === 1 ? 20 : 12);
      const ticksAt = timescaleAt + 4;
      if (duration || (version !== 0 && version !== 1) ||
          ticksAt + (version === 1 ? 8 : 4) > child.end) throw invalidVideo();
      const timescale = file.readUInt32BE(timescaleAt);
      const ticks = version === 1 ? Number(file.readBigUInt64BE(ticksAt)) : file.readUInt32BE(ticksAt);
      duration = ticks / timescale;
      if (!(duration > 0 && duration <= maxSeconds)) throw invalidVideo();
    }
  }
  if (!hasMedia || !duration) throw invalidVideo();
  return duration;
}

export async function sanitizeVideo(bytes: Buffer): Promise<Buffer> {
  const duration = movieDuration(bytes);
  if (!ffmpeg) throw new ApiError(503, "동영상 처리기를 사용할 수 없습니다.");
  const directory = await mkdtemp(join(tmpdir(), "nepeel-certificate-"));
  const input = join(directory, "source.mov");
  const output = join(directory, "media.mp4");
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    // Read one bounded, self-contained movie. No input URL or argument comes
    // from the request. Strip audio, container tags, chapters and H.264 SEI.
    try {
      await run(ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-max_alloc", "67108864",
        "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0",
        "-threads", "1", "-codec_whitelist", "h264,hevc,aac", "-max_pixels", "8388608",
        "-err_detect", "explode", "-i", input,
        "-map", "0:V:0", "-an", "-sn", "-dn", "-map_metadata", "-1",
        "-map_metadata:s:v", "-1", "-map_chapters", "-1", "-filter_threads", "1",
        "-vf", "fps=24,scale=w='min(iw,720)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        // One frame beyond the limit makes a false/short input header detectable.
        "-frames:v", String(fps * maxSeconds + 1), "-c:v", "libx264", "-threads", "1",
        "-pix_fmt", "yuv420p", "-profile:v", "main", "-preset", "veryfast",
        "-crf", "24", "-maxrate", "850k", "-bufsize", "425k",
        "-a53cc", "0", "-bsf:v", "filter_units=remove_types=6",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", "-f", "mp4", output,
      ], {
        cwd: directory,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
        timeout: 18_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC")
        throw new ApiError(503, "동영상 처리기를 사용할 수 없습니다.");
      throw invalidVideo();
    }
    const clean = await readFile(output);
    if (clean.length > CAPTURE_CERT_MAX_BYTES) throw new ApiError(413, "처리된 동영상이 너무 큽니다.");
    if (Math.abs(movieDuration(clean) - duration) > 0.25) throw invalidVideo();
    return clean;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
