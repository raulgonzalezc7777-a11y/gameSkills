// Turns the instant replay into something people send each other: a short
// vertical-friendly video with the game's sound, a meme caption and the
// game's name burnt in, plus a still of the knockout for when video is not an
// option. Everything stays on the device; sharing hands the file to the
// phone's own share sheet, and nothing is uploaded anywhere by the game.

const MIME_CHOICES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CHOICES) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* keep looking */ } }
  return null;
}

// Wraps text to a width, for the caption.
function wrap(ctx, text, max) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export class ClipMaker {
  constructor(sourceCanvas, audio) {
    this.src = sourceCanvas;
    this.audio = audio;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.mime = pickMime();
    this.recording = false;
    this.video = null;     // { blob, type, ext }
    this.photo = null;     // Blob
  }

  get canRecord() { return !!this.mime && typeof this.canvas.captureStream === 'function'; }

  // Size the clip from the screen: keep the aspect, cap the long side so the
  // file stays small enough to send over a chat app.
  _size() {
    const w = this.src.width, h = this.src.height, long = 960;
    const k = Math.min(1, long / Math.max(w, h));
    this.canvas.width = Math.max(2, Math.round((w * k) / 2) * 2);
    this.canvas.height = Math.max(2, Math.round((h * k) / 2) * 2);
  }

  begin(caption, sub) {
    this.caption = caption; this.sub = sub;
    this.video = null; this.photo = null;
    this.live = true;
    this._size();
    this.draw(0);
    if (!this.canRecord) return false;
    try {
      const stream = this.canvas.captureStream(30);
      // Game sound in the clip when the audio engine is running.
      const mixer = this.audio?.mixer;
      if (mixer?.ctx && mixer.masterGain && mixer.ctx.createMediaStreamDestination) {
        this._dest = mixer.ctx.createMediaStreamDestination();
        mixer.masterGain.connect(this._dest);
        for (const t of this._dest.stream.getAudioTracks()) stream.addTrack(t);
      }
      this.chunks = [];
      this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 3_000_000 });
      this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.rec.start(250);
      this.recording = true;
      return true;
    } catch {
      this.recording = false;
      return false;
    }
  }

  // Called right after the frame is rendered (the WebGL canvas is only
  // readable in the same task it was drawn in).
  draw(progress, isPeak = false) {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    if (!W || !H) return;
    try { c.drawImage(this.src, 0, 0, W, H); } catch { return; }
    const s = W / 540;
    // Caption band: bold, stroked, like a meme.
    c.textAlign = 'center';
    c.lineJoin = 'round';
    const size = Math.round(38 * s);
    c.font = `${size}px Anton, Impact, sans-serif`;
    const lines = wrap(c, (this.caption || '').toUpperCase(), W * 0.9);
    let y = H * 0.12;
    for (const l of lines) {
      c.lineWidth = Math.max(4, 7 * s); c.strokeStyle = '#120912'; c.strokeText(l, W / 2, y);
      c.fillStyle = '#ffffff'; c.fillText(l, W / 2, y);
      y += size * 1.05;
    }
    if (this.sub) {
      c.font = `${Math.round(18 * s)}px Rajdhani, sans-serif`;
      c.fillStyle = '#ffd33d';
      c.fillText(this.sub.toUpperCase(), W / 2, y + 4 * s);
    }
    // Watermark and a replay tag.
    c.font = `${Math.round(30 * s)}px Anton, Impact, sans-serif`;
    c.textAlign = 'right';
    c.lineWidth = 5 * s; c.strokeStyle = '#120912';
    c.strokeText('LAST CALL', W - 14 * s, H - 18 * s);
    c.fillStyle = '#ff2a6d'; c.fillText('LAST CALL', W - 14 * s, H - 18 * s);
    c.textAlign = 'left';
    c.font = `${Math.round(16 * s)}px Rajdhani, sans-serif`;
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText('● REPETICIÓN', 14 * s, H - 22 * s);
    // Progress bar along the bottom edge.
    c.fillStyle = '#ff2a6d';
    c.fillRect(0, H - 4 * s, W * Math.min(1, progress), 4 * s);
    if (isPeak && !this.photo) this.canvas.toBlob((b) => { if (b) this.photo = b; }, 'image/jpeg', 0.9);
  }

  end() {
    this.live = false;
    return new Promise((resolve) => {
      const done = () => {
        if (this._dest) { try { this.audio.mixer.masterGain.disconnect(this._dest); } catch { /* already gone */ } this._dest = null; }
        if (!this.photo) this.canvas.toBlob((b) => { this.photo = b; resolve(this); }, 'image/jpeg', 0.9);
        else resolve(this);
      };
      if (!this.recording || !this.rec) { done(); return; }
      this.recording = false;
      this.rec.onstop = () => {
        const type = this.mime.split(';')[0];
        const blob = new Blob(this.chunks, { type });
        this.video = blob.size > 1000 ? { blob, type, ext: type.includes('mp4') ? 'mp4' : 'webm' } : null;
        this.chunks = [];
        done();
      };
      try { this.rec.stop(); } catch { done(); }
    });
  }
}

// Hands a file to the phone's share sheet, or downloads it when sharing is
// not available (desktop browsers, embedded pages, app web views).
export async function shareFile(blob, name, text) {
  if (!blob) return 'none';
  const file = new File([blob], name, { type: blob.type });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'LAST CALL', text });
      return 'shared';
    }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled';
  }
  // Inside the claude.ai viewer a page cannot download on its own; the
  // viewer's downloads capability asks the player and saves the file.
  try {
    const dl = window.claude?.use ? await window.claude.use('downloads') : null;
    if (dl) {
      try { await dl.save({ filename: name, data: blob }); return 'downloaded'; }
      catch (e) { return e?.code === 'declined' ? 'cancelled' : 'failed'; }
    }
  } catch { /* not in a viewer: fall through to a plain download */ }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
