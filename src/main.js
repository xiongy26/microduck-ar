// Microduck AR: the microduck-simulator playground's physics/policy core
// wrapped in a WebXR immersive-ar scene. Scan the floor, tap to place the
// duck at true scale (~25 cm tall), drive it with a floating stick.
//
// AR routes:
//   - Android Chrome: native WebXR immersive-ar.
//   - iPhone/iPad: Safari has no WebXR; the Variant Launch SDK (App Clip)
//     provides a standards-compliant session when window.VL_KEY is set.
//   - Everything else: 3D preview with orbit controls.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  buildRig, loadKinematics, setJoint, setJawOpen, MODEL_DIR,
} from "./duck.js";
import { materialHookFor, VARIANTS, DEFAULT_VARIANT } from "./variants.js";
import {
  createSim, JOINT_NAMES, NUM_JOINTS,
  VEL_FWD, VEL_BACK, VEL_ANG, BALL_RADIUS, FENCE_HALF,
} from "./sim.js";
import { Joystick, bindButton } from "./joystick.js";
import { signed } from "./signed.js";

const $ = (id) => document.getElementById(id);
const landing = $("landing"), statusEl = $("status");
const overlay = $("overlay"), hint = $("hint"), modeTag = $("mode-tag"), areaTag = $("area-tag");
const btnAr = $("btn-ar"), btnPreview = $("btn-preview"), iosNote = $("ios-note");

const setStatus = (s) => { statusEl.textContent = s; };
const setHint = (s) => { hint.textContent = s; hint.style.display = s ? "" : "none"; };

// ── iOS / Variant Launch detection ──────────────────────────────────────
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const VL_KEY = new URLSearchParams(location.search).get("vlkey") || window.VL_KEY || "";

async function arSupported() {
  try {
    return !!navigator.xr && await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

// On iOS Safari (no WebXR) with a VL key configured, load the SDK: it
// shows the App Clip launch flow and reopens this page inside a
// WebXR-capable wrapper. Resolves once the SDK is ready (or failed).
function loadVariantLaunch() {
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = `https://launchar.app/sdk/v1?key=${encodeURIComponent(VL_KEY)}&redirect=true`;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// ── Renderer / scene (shared by AR and the preview) ─────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 40);
camera.position.set(0.7, 0.5, 0.9);

window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Anchor: the tapped floor point. MuJoCo's world origin maps here.
const anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);

// Lights ride the anchor so shadows stay centred on the play area.
const hemi = new THREE.HemisphereLight(0xffffff, 0x777788, 1.0);
anchor.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
sun.position.set(0.8, 1.6, 0.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -1.4; sun.shadow.camera.right = 1.4;
sun.shadow.camera.top = 1.4; sun.shadow.camera.bottom = -1.4;
sun.shadow.camera.near = 0.1; sun.shadow.camera.far = 5;
sun.shadow.bias = -0.0005;
anchor.add(sun);
anchor.add(sun.target);

// Shadow catcher: invisible plane that only shows the duck's shadow on
// the real floor.
const shadowPlane = new THREE.Mesh(
  new THREE.CircleGeometry(1.35, 48),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.position.y = 0.002;
shadowPlane.receiveShadow = true;
anchor.add(shadowPlane);

// Ball visual inside a Z-up -> Y-up converter, so it can take raw MJCF
// poses exactly like the duck's trunk does inside rig.root.
const ballRoot = new THREE.Group();
ballRoot.rotation.x = -Math.PI / 2;
anchor.add(ballRoot);
function beachBallTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d");
  const cols = ["#ff7a2f", "#f5f2ea", "#ffb52e", "#f5f2ea", "#e9553a", "#f5f2ea"];
  for (let i = 0; i < 6; i++) {
    g.fillStyle = cols[i];
    g.fillRect((256 / 6) * i, 0, 256 / 6 + 1, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_RADIUS, 32, 24),
  new THREE.MeshStandardMaterial({ map: beachBallTexture(), roughness: 0.4 }),
);
ballMesh.castShadow = true;
ballMesh.visible = false;
ballRoot.add(ballMesh);

// Learned play-area boundary: a thin amber rectangle on the floor that
// grows as scanning discovers more free floor (see floor learning below).
const fenceLineGeom = new THREE.BufferGeometry();
fenceLineGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
const fenceLine = new THREE.LineLoop(
  fenceLineGeom,
  new THREE.LineBasicMaterial({ color: 0xffb52e, transparent: true, opacity: 0.4 }),
);
fenceLine.position.y = 0.006;
anchor.add(fenceLine);
function updateFenceLine(f) {
  const p = fenceLineGeom.attributes.position.array;
  // MJCF (x, y) -> anchor-local (x, -y as z).
  const x0 = f.cx - f.hx, x1 = f.cx + f.hx, z0 = -(f.cy - f.hy), z1 = -(f.cy + f.hy);
  p.set([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]);
  fenceLineGeom.attributes.position.needsUpdate = true;
}

// Reticle for floor placement.
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.09, 0.115, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffb52e, transparent: true, opacity: 0.9 }),
);
const reticleDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.02, 20).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xf5f2ea }),
);
reticle.add(reticleDot);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ── Inputs ──────────────────────────────────────────────────────────────
const joystick = new Joystick({
  zone: $("touch-zone"),
  stick: $("touch-stick"),
  nub: $("touch-stick").querySelector(".nub"),
  limits: [VEL_FWD, VEL_BACK, VEL_ANG],
});
// Keyboard (preview mode / desktop debugging): arrows or WASD.
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));
const kbCommand = new Float32Array(3);
function pollKeyboard() {
  const fwd = keys.has("ArrowUp") || keys.has("KeyW");
  const back = keys.has("ArrowDown") || keys.has("KeyS");
  const left = keys.has("ArrowLeft") || keys.has("KeyA");
  const right = keys.has("ArrowRight") || keys.has("KeyD");
  kbCommand[0] = fwd ? VEL_FWD : back ? VEL_BACK : 0;
  kbCommand[2] = left ? VEL_ANG : right ? -VEL_ANG : 0;
}
const command = new Float32Array(3);
function getCommand() {
  const kb = kbCommand[0] !== 0 || kbCommand[2] !== 0;
  command[0] = kb ? kbCommand[0] : joystick.command[0];
  command[2] = kb ? kbCommand[2] : joystick.command[2];
  return command;
}

// ── Quack (chirps from the robot's voice bank) ──────────────────────────
const QUACK_MS = 480;
let quackAt = -Infinity;
const CHIRP_TAKES = "abcdefghijkl";
const chirpCache = new Map();
function quack() {
  quackAt = performance.now();
  const take = CHIRP_TAKES[(Math.random() * CHIRP_TAKES.length) | 0];
  const url = signed(`./voices/chirp_${take}.wav`);
  let a = chirpCache.get(url);
  if (!a) {
    a = new Audio(url);
    a.volume = 0.7;
    chirpCache.set(url, a);
  }
  a.currentTime = 0;
  a.play().catch(() => {});
}
let jawHeld = false;
// Ground-pick beak: the exported policies have no mouth channel, so the
// peck is re-created on the pick's phase clock (open on approach, snap
// shut on the scoop) - same keys as the playground.
const PICK_JAW_KEYS = [[0.10, 0], [0.20, 1], [0.40, 1], [0.50, 0]];
function pickJawNow() {
  const phase = sim?.pickPhase;
  if (phase == null) return 0;
  const K = PICK_JAW_KEYS;
  if (phase <= K[0][0] || phase >= K[K.length - 1][0]) return 0;
  for (let i = 1; i < K.length; i++) {
    if (phase > K[i][0]) continue;
    const [p0, v0] = K[i - 1];
    const [p1, v1] = K[i];
    const t = (phase - p0) / (p1 - p0);
    return v0 + (v1 - v0) * (1 - Math.cos(Math.PI * t)) / 2;
  }
  return 0;
}
function jawOpenNow() {
  const t = (performance.now() - quackAt) / QUACK_MS;
  const flap = t >= 0 && t < 1 ? Math.sin(Math.PI * t) : 0;
  return Math.min(1, pickJawNow() + Math.max(flap, jawHeld ? 1 : 0));
}

// ── Boot: rig + sim load in parallel while the landing shows progress ───
let rig = null, sim = null, trunkGroup = null;
const bootPromise = (async () => {
  setStatus("loading duck model");
  const k = await loadKinematics(`${MODEL_DIR}/kinematics.json`);
  const [builtRig, builtSim] = await Promise.all([
    buildRig(k, { materialForMesh: materialHookFor(VARIANTS[DEFAULT_VARIANT]) }),
    createSim({ onProgress: setStatus, getCommand }),
  ]);
  rig = builtRig;
  sim = builtSim;
  trunkGroup = rig.bodies.get("trunk_base");
  rig.placer.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  anchor.add(rig.placer);
  sim.onMode((label) => { modeTag.textContent = label; });
  // Debug/verification handle (same spirit as the playground's window.rl).
  window.duckAR = { sim, rig, anchor, camera, renderer, getCommand };
  setStatus("ready");
})();
bootPromise.catch((err) => {
  console.error("[boot]", err);
  setStatus(`boot failed: ${err?.message || err}`);
});

function syncFromSim() {
  if (!sim || !rig) return;
  const qpos = sim.data.qpos;
  trunkGroup.position.set(qpos[0], qpos[1], qpos[2]);
  trunkGroup.quaternion.set(qpos[4], qpos[5], qpos[6], qpos[3]);
  for (let j = 0; j < NUM_JOINTS; j++) setJoint(rig, JOINT_NAMES[j], qpos[sim.qposAdr[j]]);
  setJawOpen(rig, jawOpenNow());
  const b = sim.ballQposAdr;
  ballMesh.visible = sim.ballActive;
  if (sim.ballActive) {
    ballMesh.position.set(qpos[b], qpos[b + 1], qpos[b + 2]);
    ballMesh.quaternion.set(qpos[b + 4], qpos[b + 5], qpos[b + 6], qpos[b + 3]);
  }
}

// ── Session UI wiring ───────────────────────────────────────────────────
const gameChips = [$("btn-reset"), $("btn-ball"), $("btn-size"), $("btn-replace")];
function showGameUi(v) {
  $("touch-zone").hidden = !v;
  $("actions").hidden = !v;
  modeTag.hidden = !v;
  areaTag.hidden = !v;
  for (const c of gameChips) c.hidden = !v;
}
let kickFoot = "left";
bindButton($("btn-kick"), () => {
  if (sim?.triggerKick(kickFoot)) kickFoot = kickFoot === "left" ? "right" : "left";
});
bindButton($("btn-roll"), () => sim?.triggerRoll());
bindButton($("btn-pick"), () => sim?.triggerGroundPick());
bindButton($("btn-quack"), () => { quack(); jawHeld = true; }, () => { jawHeld = false; });
bindButton($("btn-reset"), () => sim?.resetSim());
bindButton($("btn-ball"), () => sim?.spawnBall());

const SIZES = [1, 2, 3];
let sizeIdx = 0;
bindButton($("btn-size"), () => {
  const prev = SIZES[sizeIdx];
  sizeIdx = (sizeIdx + 1) % SIZES.length;
  const next = SIZES[sizeIdx];
  anchor.scale.setScalar(next);
  $("btn-size").textContent = `size ${next}x`;
  // Learned floor bounds live in MJCF metres, i.e. physical metres divided
  // by the visual scale: rescale them so the fence keeps matching the SAME
  // physical floor at the new scale.
  if (sim && floorBounds) {
    const f = prev / next;
    floorBounds.minx *= f; floorBounds.maxx *= f;
    floorBounds.miny *= f; floorBounds.maxy *= f;
    applyFence(fenceFromBounds());
  }
});

// ── Placement ───────────────────────────────────────────────────────────
// Stability gate: ARKit's first hit-tests come from rough estimated planes
// (that's what reads as "wrong distance/size"). Placement only unlocks
// once the last N hit points agree within a few cm - i.e. the tracker has
// locked a real plane.
const HIT_STABLE_N = 12;
const HIT_STABLE_TOL = 0.035; // m of spread across the window
const hitHistory = [];
let hitStable = false;
let lastHitResult = null; // XRHitTestResult, for anchor creation
let xrAnchor = null; // XRAnchor pinning the play area while tracking refines
let anchorYaw = 0;
function hitStability(p) {
  hitHistory.push([p.x, p.y, p.z]);
  if (hitHistory.length > HIT_STABLE_N) hitHistory.shift();
  if (hitHistory.length < HIT_STABLE_N) return false;
  let mx = 0, my = 0, mz = 0;
  for (const h of hitHistory) { mx += h[0]; my += h[1]; mz += h[2]; }
  mx /= hitHistory.length; my /= hitHistory.length; mz /= hitHistory.length;
  let worst = 0;
  for (const h of hitHistory) {
    worst = Math.max(worst, Math.hypot(h[0] - mx, h[1] - my, h[2] - mz));
  }
  return worst < HIT_STABLE_TOL;
}
let placing = false;

// ── Floor size estimation ───────────────────────────────────────────────
// iOS wrappers expose no plane or depth API, so the usable floor size is
// learned by accumulation instead: after placement the viewer hit-test
// keeps running, and every hit that lands on the placement plane expands
// the play-area rectangle - physics fence walls (moved at runtime inside
// MuJoCo), boundary line and the on-screen measurement all follow.
const FLOOR_Y_TOL = 0.12; // m off the placement plane still counts as floor
const FENCE_MIN = 0.6, FENCE_MAX = 2.5; // half-extents, MJCF metres
let floorBounds = null;
function fenceFromBounds() {
  const cx = (floorBounds.minx + floorBounds.maxx) / 2;
  const cy = (floorBounds.miny + floorBounds.maxy) / 2;
  const hx = Math.min(FENCE_MAX, Math.max(FENCE_MIN, (floorBounds.maxx - floorBounds.minx) / 2));
  const hy = Math.min(FENCE_MAX, Math.max(FENCE_MIN, (floorBounds.maxy - floorBounds.miny) / 2));
  return { cx, cy, hx, hy };
}
function applyFence(f) {
  sim.setFence(f.cx, f.cy, f.hx, f.hy);
  updateFenceLine(f);
  const s = SIZES[sizeIdx];
  areaTag.textContent = `floor ~ ${(2 * f.hx * s).toFixed(1)} x ${(2 * f.hy * s).toFixed(1)} m`;
}
function resetFloorBounds() {
  floorBounds = { minx: -FENCE_MIN, maxx: FENCE_MIN, miny: -FENCE_MIN, maxy: FENCE_MIN };
  applyFence(fenceFromBounds());
}
const _fp = new THREE.Vector3();
function learnFloorPoint(p) {
  _fp.set(p.x, p.y, p.z);
  anchor.worldToLocal(_fp); // includes the 1/scale, so bounds stay in MJCF metres
  if (Math.abs(_fp.y) > FLOOR_Y_TOL) return; // a table/other level, not this floor
  const mx = _fp.x, my = -_fp.z;
  if (Math.abs(mx) > FENCE_MAX * 2 || Math.abs(my) > FENCE_MAX * 2) return;
  const b = floorBounds;
  const grew = mx < b.minx - 0.02 || mx > b.maxx + 0.02 || my < b.miny - 0.02 || my > b.maxy + 0.02;
  if (!grew) return;
  b.minx = Math.min(b.minx, mx); b.maxx = Math.max(b.maxx, mx);
  b.miny = Math.min(b.miny, my); b.maxy = Math.max(b.maxy, my);
  applyFence(fenceFromBounds());
}

const _hitPos = new THREE.Vector3();
const _hitQuat = new THREE.Quaternion();
const _hitScale = new THREE.Vector3();
const _camPos = new THREE.Vector3();
function placeAnchorFromReticle() {
  reticle.matrix.decompose(_hitPos, _hitQuat, _hitScale);
  anchor.position.copy(_hitPos);
  // Face the duck (local +X) toward the viewer.
  camera.getWorldPosition(_camPos);
  const dx = _camPos.x - _hitPos.x, dz = _camPos.z - _hitPos.z;
  const n = Math.hypot(dx, dz) || 1;
  anchorYaw = Math.atan2(-dz / n, dx / n);
  anchor.rotation.set(0, anchorYaw, 0);
  anchor.visible = true;
  placing = false;
  reticle.visible = false;
  // Pin the play area to an ARKit anchor when the platform offers one:
  // as tracking refines its world map, the anchor pose is corrected and
  // the duck stays glued to the real floor instead of drifting with the
  // session origin.
  xrAnchor = null;
  if (lastHitResult?.createAnchor) {
    lastHitResult.createAnchor().then((a) => { xrAnchor = a; }).catch(() => {});
  }
  sim.resetSim();
  resetFloorBounds();
  sim.paused = false;
  setHint("scan around to grow the play area");
  showGameUi(true);
}
bindButton($("btn-replace"), () => {
  placing = true;
  hitHistory.length = 0;
  hitStable = false;
  xrAnchor = null;
  sim.paused = true;
  showGameUi(false);
  setHint("point at the floor, tap to move the duck");
});

// ── AR session ──────────────────────────────────────────────────────────
let xrSession = null;
let hitTestSource = null;
let localSpace = null;

async function startAr() {
  await bootPromise;
  const overlayRoot = overlay;
  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"],
    // anchors: pin the play area against tracking drift (Variant Launch
    // and ARCore both offer them). depth-sensing: real-world occlusion,
    // granted on Android Chrome (three renders the occlusion automatically);
    // iOS wrappers don't expose depth yet.
    optionalFeatures: ["dom-overlay", "local-floor", "anchors", "depth-sensing", "light-estimation"],
    depthSensing: { usagePreference: ["gpu-optimized"], dataFormatPreference: ["luminance-alpha"] },
    domOverlay: { root: overlayRoot },
  });
  console.log("[xr] granted features:", [...(xrSession.enabledFeatures ?? [])].join(", ") || "unknown");
  // Touches on the control overlay must not double as AR select taps.
  overlayRoot.addEventListener("beforexrselect", (e) => e.preventDefault());
  landing.style.display = "none";
  overlay.classList.add("live");
  showGameUi(false);
  setHint("point your phone at the floor");
  placing = true;
  hitHistory.length = 0;
  hitStable = false;
  xrAnchor = null;
  anchor.visible = false;
  anchor.scale.setScalar(SIZES[sizeIdx]);

  // Probe the reference space before handing the session to three:
  // Variant Launch only implements "local", Chrome grants "local-floor".
  let refType = "local-floor";
  try {
    await xrSession.requestReferenceSpace("local-floor");
  } catch {
    refType = "local";
  }
  renderer.xr.setReferenceSpaceType(refType);
  await renderer.xr.setSession(xrSession);
  localSpace = renderer.xr.getReferenceSpace();
  const viewerSpace = await xrSession.requestReferenceSpace("viewer");
  hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

  xrSession.addEventListener("select", () => {
    if (placing && reticle.visible && hitStable) placeAnchorFromReticle();
  });
  xrSession.addEventListener("end", () => {
    xrSession = null;
    hitTestSource = null;
    xrAnchor = null;
    lastHitResult = null;
    sim.paused = true;
    overlay.classList.remove("live");
    landing.style.display = "";
    anchor.visible = false;
    setStatus("ready");
  });
}
bindButton($("btn-exit"), () => {
  if (xrSession) xrSession.end().catch(() => {});
  else exitPreview();
});

// ── 3D preview (desktop / unsupported browsers) ─────────────────────────
let previewOn = false;
let controls = null;
const previewFloor = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.9 }),
);
previewFloor.receiveShadow = true;
previewFloor.visible = false;
scene.add(previewFloor);
const previewGrid = new THREE.GridHelper(4.4, 22, 0x555560, 0x33333c);
previewGrid.position.y = 0.001;
previewGrid.visible = false;
scene.add(previewGrid);

async function startPreview() {
  await bootPromise;
  previewOn = true;
  landing.style.display = "none";
  overlay.classList.add("live");
  scene.background = new THREE.Color(0x101016);
  previewFloor.visible = true;
  previewGrid.visible = true;
  anchor.position.set(0, 0, 0);
  anchor.rotation.set(0, Math.PI / 2, 0); // duck faces the camera
  anchor.visible = true;
  controls ??= new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.12, 0);
  controls.minDistance = 0.3;
  controls.maxDistance = 5;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.enabled = true;
  setHint("");
  showGameUi(true);
  sim.resetSim();
  floorBounds = null; // no scanning in preview: fixed 2 x 2 m pen
  sim.setFence(0, 0, 1, 1);
  updateFenceLine(sim.fence);
  areaTag.textContent = "floor 2.0 x 2.0 m";
  sim.paused = false;
}
function exitPreview() {
  previewOn = false;
  sim.paused = true;
  if (controls) controls.enabled = false;
  scene.background = null;
  previewFloor.visible = false;
  previewGrid.visible = false;
  anchor.visible = false;
  overlay.classList.remove("live");
  landing.style.display = "";
}

// ── Frame loop (drives both AR and preview) ─────────────────────────────
renderer.setAnimationLoop((t, frame) => {
  pollKeyboard();
  joystick.poll();
  if (frame && hitTestSource && placing) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(localSpace);
      if (pose) {
        lastHitResult = hits[0];
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        hitStable = hitStability(pose.transform.position);
        reticle.material.color.setHex(hitStable ? 0xffb52e : 0x8a8a95);
        reticle.material.opacity = hitStable ? 0.95 : 0.5;
        setHint(hitStable
          ? "tap to place the duck"
          : "scanning the floor - sweep the phone slowly");
      }
    } else {
      reticle.visible = false;
      hitStable = false;
      hitHistory.length = 0;
      setHint("point your phone at the floor - move slowly");
    }
  }
  // Floor learning: while playing, every hit-test on the placement plane
  // grows the fence to the floor actually scanned.
  if (frame && hitTestSource && !placing && anchor.visible && localSpace && floorBounds) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(localSpace);
      if (pose) learnFloorPoint(pose.transform.position);
    }
  }
  // Anchored play area: follow ARKit's corrected anchor pose so the duck
  // stays on the real floor while the world map refines.
  if (frame && xrAnchor && anchor.visible && localSpace) {
    try {
      const pose = frame.getPose(xrAnchor.anchorSpace, localSpace);
      if (pose) {
        const p = pose.transform.position;
        anchor.position.set(p.x, p.y, p.z);
        anchor.rotation.set(0, anchorYaw, 0);
      }
    } catch { /* anchor deleted by the system */ }
  }
  syncFromSim();
  if (previewOn && controls) controls.update();
  renderer.render(scene, camera);
});

// ── Landing buttons ─────────────────────────────────────────────────────
(async () => {
  let supported = await arSupported();
  if (!supported && IS_IOS && VL_KEY) {
    setStatus("loading iOS AR bridge");
    await loadVariantLaunch();
    supported = await arSupported();
  }
  if (!supported && IS_IOS && !VL_KEY) {
    iosNote.hidden = false;
    iosNote.innerHTML =
      "iPhone Safari has no WebXR yet: AR here needs a (free) " +
      '<a href="https://launch.variant3d.com" target="_blank" rel="noreferrer">Variant Launch</a> ' +
      "key for this domain (set <code>window.VL_KEY</code> in index.html). " +
      "The 3D preview below runs the same physics + policies.";
  }
  btnAr.disabled = !supported;
  if (!supported) btnAr.textContent = "AR not available";
  btnPreview.disabled = false;
  bootPromise.then(() => setStatus("ready"));
})();

btnAr.addEventListener("click", () => {
  startAr().catch((err) => {
    console.error("[xr]", err);
    setStatus(`AR failed: ${err?.message || err}`);
    overlay.classList.remove("live");
    landing.style.display = "";
  });
});
btnPreview.addEventListener("click", () => {
  startPreview().catch((err) => {
    console.error("[preview]", err);
    setStatus(`preview failed: ${err?.message || err}`);
  });
});
