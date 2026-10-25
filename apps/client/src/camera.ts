// 斜俯角透視相機：規則在平面上，畫面可以縮放、旋轉、傾斜、拖曳（Homeworld 式「假宇宙真 2D」）。
// 世界座標：x 向右、y 向下（地圖座標），z 向上（只用來表現高度）。

export interface Projected {
  x: number;
  y: number;
  /** 該點每單位世界長度在螢幕上的像素數 */
  k: number;
  visible: boolean;
}

export type CameraView = Pick<Camera, 'tx' | 'ty' | 'yaw' | 'pitch' | 'dist'>;

const DEG = Math.PI / 180;
const FOV = 45 * DEG;

export class Camera {
  /** 注視點（地面上） */
  tx: number;
  ty: number;
  /** 水平旋轉；0 時地圖的 -y 朝向畫面上方 */
  yaw = 0;
  /** 俯角；90° 為正上方往下看 */
  pitch = 55 * DEG;
  dist = 30;
  width = 800;
  height = 600;

  constructor(private mapSize: number) {
    this.tx = mapSize / 2;
    this.ty = mapSize / 2;
  }

  private basis() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp;
    const fy = -Math.cos(this.yaw) * cp;
    const fz = -sp;
    const rx = Math.cos(this.yaw);
    const ry = Math.sin(this.yaw);
    // U = F × R（R 的 z 為 0）
    const ux = -fz * ry;
    const uy = fz * rx;
    const uz = fx * ry - fy * rx;
    const cx = this.tx - fx * this.dist;
    const cy = this.ty - fy * this.dist;
    const cz = -fz * this.dist;
    const focal = this.height / 2 / Math.tan(FOV / 2);
    return { fx, fy, fz, rx, ry, ux, uy, uz, cx, cy, cz, focal };
  }

  project(x: number, y: number, z = 0): Projected {
    const b = this.basis();
    const dx = x - b.cx;
    const dy = y - b.cy;
    const dz = z - b.cz;
    const xc = dx * b.rx + dy * b.ry;
    const yc = dx * b.ux + dy * b.uy + dz * b.uz;
    const zc = dx * b.fx + dy * b.fy + dz * b.fz;
    if (zc < 0.2) return { x: 0, y: 0, k: 0, visible: false };
    const k = b.focal / zc;
    return { x: this.width / 2 + xc * k, y: this.height / 2 - yc * k, k, visible: true };
  }

  /** 螢幕座標對應到地面（z=0）上的哪一點 */
  unproject(sx: number, sy: number): { x: number; y: number } | null {
    const b = this.basis();
    const px = (sx - this.width / 2) / b.focal;
    const py = -(sy - this.height / 2) / b.focal;
    const dx = b.fx + b.rx * px + b.ux * py;
    const dy = b.fy + b.ry * px + b.uy * py;
    const dz = b.fz + b.uz * py;
    if (dz >= -1e-6) return null;
    const t = -b.cz / dz;
    return { x: b.cx + dx * t, y: b.cy + dy * t };
  }

  save(): CameraView {
    return { tx: this.tx, ty: this.ty, yaw: this.yaw, pitch: this.pitch, dist: this.dist };
  }

  restore(v: CameraView) {
    Object.assign(this, v);
  }

  reset() {
    this.tx = this.mapSize / 2;
    this.ty = this.mapSize / 2;
    this.yaw = 0;
    this.pitch = 55 * DEG;
    this.dist = this.fitDistance();
  }

  /** 讓整張地圖剛好放進畫面的距離 */
  fitDistance(): number {
    const aspect = this.width / Math.max(1, this.height);
    const half = this.mapSize * 0.62;
    const byH = half / Math.tan(FOV / 2);
    const byW = half / (Math.tan(FOV / 2) * aspect);
    return Math.max(byH, byW);
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.unproject(sx, sy);
    this.dist = Math.max(6, Math.min(80, this.dist * factor));
    const after = this.unproject(sx, sy);
    if (before && after) this.panBy(before.x - after.x, before.y - after.y);
  }

  panBy(dx: number, dy: number) {
    const m = this.mapSize;
    this.tx = Math.max(-m * 0.25, Math.min(m * 1.25, this.tx + dx));
    this.ty = Math.max(-m * 0.25, Math.min(m * 1.25, this.ty + dy));
  }

  rotate(dYaw: number, dPitch = 0) {
    this.yaw += dYaw;
    this.pitch = Math.max(20 * DEG, Math.min(90 * DEG, this.pitch + dPitch));
  }

  get topDown(): boolean {
    return this.pitch > 85 * DEG;
  }

  toggleTopDown() {
    this.pitch = this.topDown ? 55 * DEG : 90 * DEG;
  }
}

export interface CameraInput {
  /** 沒拖曳的單擊（螢幕座標） */
  onClick(sx: number, sy: number): void;
  onHover(sx: number, sy: number): void;
  onLeave(): void;
}

/**
 * 滑鼠：左鍵拖曳平移、右鍵（或 Shift＋左鍵）拖曳旋轉與傾斜、滾輪縮放（以游標為中心）。
 * 鍵盤：Q／E 旋轉、R 重置、T 切換俯視。
 */
export function attachCameraControls(canvas: HTMLCanvasElement, cam: Camera, input: CameraInput) {
  let drag: { button: number; rotate: boolean; x: number; y: number; moved: boolean } | null = null;
  const pos = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    const p = pos(e);
    drag = { button: e.button, rotate: e.button === 2 || (e.button === 0 && e.shiftKey), x: p.x, y: p.y, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    const p = pos(e);
    if (!drag) {
      if (e.target === canvas) input.onHover(p.x, p.y);
      return;
    }
    const dx = p.x - drag.x;
    const dy = p.y - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.rotate) {
      cam.rotate(dx * 0.008, -dy * 0.006);
    } else {
      const a = cam.unproject(drag.x, drag.y);
      const b = cam.unproject(p.x, p.y);
      if (a && b) cam.panBy(a.x - b.x, a.y - b.y);
    }
    drag.x = p.x;
    drag.y = p.y;
  });
  window.addEventListener('mouseup', (e) => {
    if (drag && !drag.moved && drag.button === 0 && e.target === canvas) {
      const p = pos(e);
      input.onClick(p.x, p.y);
    }
    drag = null;
  });
  canvas.addEventListener('mouseleave', () => input.onLeave());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = pos(e);
      cam.zoomAt(p.x, p.y, Math.exp(e.deltaY * 0.0015));
    },
    { passive: false },
  );
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k === 'q') cam.rotate(-15 * DEG);
    else if (k === 'e') cam.rotate(15 * DEG);
    else if (k === 'r') cam.reset();
    else if (k === 't') cam.toggleTopDown();
  });
}
