/**
 * 通话星球球体（原创 WebGL 实现）。
 *
 * 设计目标：一颗安静的"行星"挂在通话区中央 —— 表面有缓慢流动的雾带，
 * 用户说话时被电平吹亮、转暗，AI 说话时整体泛亮脉动，静音时褪成灰调。
 * 状态不靠贴图，全靠一个 fragment shader 现算：
 *
 *   - 球体用 SDF 方式画：屏幕半径 r 反推球面高度 z 与法线 n，不用网格。
 *   - 表面纹理是 3 个倍频的 value-noise（fbm）在经纬坐标上滚动，
 *     形成云带 / 雾气的错落感；滚动速度跟电平走（安静时近乎静止）。
 *   - 边缘 Fresnel 发光 + 左上固定光源的漫反射，保证立体感。
 *   - 每套皮肤只是三个颜色 uniform（浅 / 中 / 强调），换肤不重建程序。
 *
 * 动效节奏（spring）放在 JS 侧做：shader 里没有状态，所有"生命感"都来自
 * uEnergy / uActivity 的连续输入 —— 这样打断、静音、挂断都能立刻定格，
 * 也方便 prefers-reduced-motion 整个停掉。
 *
 * 无 WebGL / 上下文丢失时不调用这里（组件层退回 CSS 渐变球）。
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
/** 0..1 麦克风能量（弹簧平滑后）。 */
uniform float uEnergy;
/** 0..1 助手正在说话的强度。 */
uniform float uActivity;
/** 0..1 静音褪灰程度。 */
uniform float uMuted;
uniform vec3 uA; // 浅底
uniform vec3 uB; // 主体
uniform vec3 uC; // 强调 / 边缘光

// 两个三角拼出的全屏 quad，球心恒在画布中心。

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash(i);
  float n100 = hash(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

/** 3 倍频：足够错落又不至于在 mediump 下起带纹。 */
float fbm(vec3 p) {
  float v = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 3; i++) {
    v += amp * vnoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * uRes.y);
  float r = length(p);
  float R = 0.92;
  if (r > R) {
    // 球外：一层极淡的外圈光，让球体从背景里"浮"出来。
    float halo = smoothstep(R + 0.10, R, r) * (0.10 + 0.18 * uEnergy + 0.14 * uActivity);
    gl_FragColor = vec4(uC, halo);
    return;
  }
  // SDF 球：由屏幕半径反推球面法线。
  float z = sqrt(max(R * R - r * r, 0.0));
  vec3 n = normalize(vec3(p, z / R));

  // 经纬滚动：静音时几乎静止，说话时明显流动。
  float drift = uTime * (0.045 + 0.22 * uEnergy + 0.10 * uActivity);
  float lon = atan(n.x, n.z) + drift;
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float f = fbm(vec3(lon * 1.7, lat * 3.1 + uTime * 0.02, uTime * 0.10));

  // 云带分层 + 极区微变。
  vec3 col = mix(uA, uB, smoothstep(0.34, 0.66, f + 0.10 * lat));
  col = mix(col, uC, smoothstep(0.62, 0.92, f * 0.6 + 0.34 * (1.0 - abs(lat))) * (0.35 + uEnergy));

  // 漫反射（左上光）+ Fresnel 边缘光。
  float diff = max(dot(n, normalize(vec3(-0.42, 0.55, 0.72))), 0.0);
  col *= 0.72 + 0.34 * diff;
  float fres = pow(1.0 - z / R, 2.2);
  col += uC * fres * (0.34 + 0.55 * uEnergy + 0.45 * uActivity);

  // 说话时整体泛亮一点点（"活"的感觉）。
  col *= 1.0 + 0.10 * uActivity;

  // 静音：褪成冷灰，边缘光也收掉。
  vec3 gray = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
  col = mix(col, mix(col, gray, 0.85) * 0.92, uMuted);

  gl_FragColor = vec4(col, smoothstep(R, R - 0.02, r));
}
`;

export type OrbSkin = { a: [number, number, number]; b: [number, number, number]; c: [number, number, number] };

/** 把 #rrggbb 转成 0..1 三元组。 */
export function hex2rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export type OrbRenderer = {
  /** 目标能量 0..1（麦克风）；渲染循环自己做弹簧平滑。 */
  setTargetEnergy(v: number): void;
  /** 助手是否正在朗读（0/1 连续过渡）。 */
  setSpeaking(on: boolean): void;
  /** 静音褪灰（0/1 连续过渡）。 */
  setMuted(on: boolean): void;
  /** 慢速档（拨号 / 思考时流动变快）。 */
  setBusy(on: boolean): void;
  setSkin(skin: OrbSkin): void;
  resize(cssW: number, cssH: number): void;
  /** 停掉 rAF 并释放 GL 资源。 */
  dispose(): void;
};

/**
 * 在 canvas 上起一个球体渲染循环。canvas 必须已经 append 且有 CSS 尺寸。
 * 返回 null 表示环境不支持 WebGL（调用方退回 CSS 渐变）。
 */
export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer | null {
  const gl = (canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true }) ??
    canvas.getContext("experimental-webgl", { alpha: true })) as WebGLRenderingContext | null;
  if (!gl) return null;

  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // 全屏两三角。
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {
    res: gl.getUniformLocation(prog, "uRes"),
    time: gl.getUniformLocation(prog, "uTime"),
    energy: gl.getUniformLocation(prog, "uEnergy"),
    activity: gl.getUniformLocation(prog, "uActivity"),
    muted: gl.getUniformLocation(prog, "uMuted"),
    a: gl.getUniformLocation(prog, "uA"),
    b: gl.getUniformLocation(prog, "uB"),
    c: gl.getUniformLocation(prog, "uC"),
  };

  let dpr = 1;
  let w = 1;
  let h = 1;
  let energy = 0;
  let target = 0;
  let activity = 0;
  let speakOn = false;
  let mutedMix = 0;
  let mutedOn = false;
  let busy = false;
  let skin: OrbSkin = { a: [0.86, 0.93, 0.88], b: [0.35, 0.62, 0.5], c: [0.24, 0.44, 0.36] };
  let raf: number | null = null;
  let t0 = performance.now();
  /** 时间积分：换 busy 档时不跳相位，只改增速。 */
  let phase = 0;
  let lastFrame = t0;

  const render = (now: number) => {
    raf = requestAnimationFrame(render);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    phase += dt * (busy ? 2.6 : 1.0);
    // 临界阻尼弹簧：追得上电平又不会抖。
    energy += (target - energy) * Math.min(1, dt * 9);
    activity += ((speakOn ? 1 : 0) - activity) * Math.min(1, dt * 6);
    mutedMix += ((mutedOn ? 1 : 0) - mutedMix) * Math.min(1, dt * 8);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.res, w, h);
    gl.uniform1f(U.time, phase);
    gl.uniform1f(U.energy, energy);
    gl.uniform1f(U.activity, activity);
    gl.uniform1f(U.muted, mutedMix);
    gl.uniform3fv(U.a, skin.a);
    gl.uniform3fv(U.b, skin.b);
    gl.uniform3fv(U.c, skin.c);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const onLost = (e: Event) => {
    // 上下文丢失（GPU 重置 / 休眠唤醒）：停循环，让组件层换回 CSS 球。
    e.preventDefault();
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };
  canvas.addEventListener("webglcontextlost", onLost);
  raf = requestAnimationFrame(render);

  return {
    setTargetEnergy(v) {
      target = Math.max(0, Math.min(1, v));
    },
    setSpeaking(on) {
      speakOn = on;
    },
    setMuted(on) {
      mutedOn = on;
    },
    setBusy(on) {
      busy = on;
    },
    setSkin(s) {
      skin = s;
    },
    resize(cssW, cssH) {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(cssW * dpr));
      h = Math.max(1, Math.round(cssH * dpr));
      canvas.width = w;
      canvas.height = h;
    },
    dispose() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteBuffer(buf);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      void t0;
    },
  };
}
