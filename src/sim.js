// Microduck AR sim core: the REAL trained RL policies stepping real MuJoCo
// physics, trimmed from the microduck-simulator playground (pollen-robotics)
// for AR: no arena visuals, no props, no rollers - just the walking duck, a
// kickable ball, one-shot kicks/rolls and the automatic fall recovery.
//
// Physics: MuJoCo WASM (@mujoco/mujoco), timestep 0.005 s, decimation 4.
// Controller: ONNX checkpoints from apirrone/microduck_runtime, run with
// onnxruntime-web at 50 Hz. Obs layout (61D):
//   [base_ang_vel(3), projected_gravity(3), joint_pos(14), joint_vel(14),
//    last_action(14), command(13)]

import * as THREE from "three";
import { MODEL_DIR, MESH_VERSION, loadGlbGeometries, geometryToBinaryStl } from "./duck.js";
import { signed } from "./signed.js";

const MUJOCO_URL = "https://cdn.jsdelivr.net/npm/@mujoco/mujoco@3.11.0/mujoco.js";
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.mjs";
const ORT_WASM_DIR = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const POLICY_DIR = "./policies";
const POLICIES = {
  walk: `${POLICY_DIR}/BEST_alpha_walking.onnx`,
  kickL: `${POLICY_DIR}/ball_kick_left.onnx`,
  kickR: `${POLICY_DIR}/ball_kick_right.onnx`,
  roll: `${POLICY_DIR}/roulade.onnx`,
  groundpick: `${POLICY_DIR}/alpha_ground_pick.onnx`,
  stand: `${POLICY_DIR}/BEST_alpha_stand.onnx`,
};

export const JOINT_NAMES = [
  "left_hip_yaw", "left_hip_roll", "left_hip_pitch", "left_knee", "left_ankle",
  "neck_pitch", "head_pitch", "head_yaw", "head_roll",
  "right_hip_yaw", "right_hip_roll", "right_hip_pitch", "right_knee", "right_ankle",
];
export const DEFAULT_POSE = new Float32Array([
  0, -0.08726646259971647, -0.457924, -0.004940, 0.452984,
  0.3490658503988659, 0.3490658503988659, 0, 0,
  0, 0.08726646259971647, 0.457924, 0.004940, -0.452984,
]);
export const NUM_JOINTS = 14;
const OBS_SIZE = 61;
const CMD_SIZE = 13;
const ACTION_SCALE = 1.0;
const TIMESTEP = 0.005;
const DECIMATION = 4;
export const CTRL_DT = TIMESTEP * DECIMATION; // 50 Hz

// Velocity command limits (infer_policy.py's keyboard mapping).
export const VEL_FWD = 0.25, VEL_BACK = -0.2, VEL_ANG = 1.0;

export const BALL_RADIUS = 0.05;
const BALL_PARK_POS = "50 0 0.05";
// Invisible fence keeping duck + ball within reach of the placement spot.
export const FENCE_HALF = 1.0;

const KICK_STEPS = 25; // 0.5 s window
const POST_KICK_LOCK_STEPS = 20;
// Ground-pick one-shot: phase clock encoded as [cos, sin, 0] in the
// command vel slots (runtime defaults: 4 s period, cycle exits at 0.7).
const GROUND_PICK_PERIOD_S = 4.0;
const GROUND_PICK_END_PHASE = 0.7;
// Fall recovery (mirrors the runtime's --fall-detect state machine).
const FALL_DEBOUNCE_STEPS = 10;
const FALL_SETTLE_STEPS = 15;
const RECOVER_UPRIGHT_STEPS = 50;
const RECOVER_GIVEUP_STEPS = 300;

export async function createSim({ onProgress = () => {}, getCommand }) {
  const step = (msg) => onProgress(msg);

  step("loading runtimes");
  const [{ default: loadMujocoFactory }, ort] = await Promise.all([
    import(/* @vite-ignore */ MUJOCO_URL),
    import(/* @vite-ignore */ ORT_URL),
  ]);
  ort.env.wasm.wasmPaths = ORT_WASM_DIR;
  ort.env.wasm.numThreads = 1; // static hosting sends no COOP/COEP headers

  // ── MJCF: strip visual geoms, add floor + fence + ball + STAND key ────
  step("preparing physics model");
  async function buildPhysicsXml() {
    const src = await (await fetch(signed(`${MODEL_DIR}/robot_allcollisions.xml`))).text();
    const doc = new DOMParser().parseFromString(src, "text/xml");
    for (const g of [...doc.querySelectorAll('geom[class="visual"]')]) g.remove();
    const usedMeshes = new Set(
      [...doc.querySelectorAll("geom[mesh]")].map((g) => g.getAttribute("mesh")),
    );
    for (const m of [...doc.querySelectorAll("asset > mesh")]) {
      const name = m.getAttribute("name") ?? m.getAttribute("file").replace(/\.stl$/i, "");
      if (!usedMeshes.has(name)) m.remove();
    }
    const root = doc.documentElement;
    const el = (tag, attrs) => {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };
    root.appendChild(el("option", { timestep: String(TIMESTEP) }));
    const world = doc.querySelector("worldbody");
    world.appendChild(el("geom", { name: "floor", type: "plane", size: "0 0 0.05", pos: "0 0 0" }));
    const ht = 0.025, hh = 0.125;
    const off = FENCE_HALF + ht, span = FENCE_HALF + 0.05;
    for (const w of [
      { name: "wall_px", pos: `${off} 0 ${hh}`, size: `${ht} ${span} ${hh}` },
      { name: "wall_nx", pos: `${-off} 0 ${hh}`, size: `${ht} ${span} ${hh}` },
      { name: "wall_py", pos: `0 ${off} ${hh}`, size: `${span} ${ht} ${hh}` },
      { name: "wall_ny", pos: `0 ${-off} ${hh}`, size: `${span} ${ht} ${hh}` },
    ]) {
      world.appendChild(el("geom", { name: w.name, type: "box", pos: w.pos, size: w.size }));
    }
    const ballBody = el("body", { name: "ball", pos: BALL_PARK_POS });
    ballBody.appendChild(el("freejoint", { name: "ball_freejoint" }));
    ballBody.appendChild(el("geom", {
      name: "ball_geom", type: "sphere", size: String(BALL_RADIUS),
      mass: "0.03", friction: "0.4 0.01 0.003", solref: "0.03 0.4", condim: "6",
    }));
    world.appendChild(ballBody);
    // STAND keyframe: freejoint + every hinge in document order + ball.
    const qposFree = "0 0 0.12 1 0 0 0";
    const poseByName = new Map(JOINT_NAMES.map((n, i) => [n, DEFAULT_POSE[i]]));
    const qposJoints = [...doc.querySelectorAll("body > joint")]
      .map((j) => poseByName.get(j.getAttribute("name")) ?? 0)
      .join(" ");
    const kf = doc.createElement("keyframe");
    kf.appendChild(el("key", {
      name: "STAND",
      qpos: `${qposFree} ${qposJoints} ${BALL_PARK_POS} 1 0 0 0`,
      ctrl: Array.from(DEFAULT_POSE).join(" "),
    }));
    root.appendChild(kf);
    const meshFiles = [...doc.querySelectorAll("asset > mesh")].map((m) => m.getAttribute("file"));
    return { xml: new XMLSerializer().serializeToString(doc), meshFiles };
  }

  const [mujoco, { xml, meshFiles }] = await Promise.all([
    loadMujocoFactory(),
    buildPhysicsXml(),
  ]);

  step("building collision meshes");
  const vfs = new mujoco.MjVFS();
  const geoms = await loadGlbGeometries();
  await Promise.all(
    meshFiles.map(async (f) => {
      // Collision meshes rebuilt from the already-loaded visual GLB where
      // possible; anything missing falls back to its STL.
      const entry = geoms.get(f);
      const buf = entry
        ? geometryToBinaryStl(entry.welded)
        : await (await fetch(signed(`${MODEL_DIR}/meshes/${f}?v=${MESH_VERSION}`), { cache: "force-cache" })).arrayBuffer();
      vfs.addBuffer(`assets/${f}`, new Uint8Array(buf));
    }),
  );

  step("loading policies");
  const sessionOpts = { executionProviders: ["wasm"] };
  const sessions = {};
  let loaded = 0;
  await Promise.all(Object.entries(POLICIES).map(async ([name, url]) => {
    sessions[name] = await ort.InferenceSession.create(signed(url), sessionOpts);
    step(`loading policies ${++loaded}/${Object.keys(POLICIES).length}`);
  }));

  step("compiling physics");
  const model = mujoco.MjModel.from_xml_string(xml, vfs);
  const data = new mujoco.MjData(model);

  const qposAdr = JOINT_NAMES.map((n) => model.jnt(n).qposadr);
  const dofAdr = JOINT_NAMES.map((n) => model.jnt(n).dofadr);
  const gyroAdr = model.sensor("imu_ang_vel").adr;
  const trunkId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, "trunk_base");
  const standKeyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY.value, "STAND");
  const ballQposAdr = model.jnt("ball_freejoint").qposadr;
  const ballDofAdr = model.jnt("ball_freejoint").dofadr;

  const lastAction = new Float32Array(NUM_JOINTS);
  const obs = new Float32Array(OBS_SIZE);
  const cmd = new Float32Array(CMD_SIZE);
  const ZERO_CMD = new Float32Array(3);

  let mode = "walk"; // "walk" | "roll" | "kickL" | "kickR" | "groundpick"
  let kickRun = null;
  let rollRun = null;
  let pickRun = null;
  let postKickLock = 0;
  let recovery = null; // null | { state: "fallen"|"recovering", steps, uprightSteps }
  let fallDebounce = 0;
  let fallenSince = null;
  let ballActive = false;
  let paused = true;
  const isKick = () => mode === "kickL" || mode === "kickR";

  const listeners = { mode: [] };
  const emitMode = () => {
    const label = recovery ? "recovery"
      : mode === "roll" ? "roll"
      : mode === "groundpick" ? "pick"
      : isKick() ? "kick" : "walk";
    for (const fn of listeners.mode) fn(label);
  };

  function effectiveCmd() {
    if (mode !== "walk" || postKickLock > 0 || recovery) return ZERO_CMD;
    return getCommand();
  }

  function parkBallPhysics() {
    const qpos = data.qpos, qvel = data.qvel;
    qpos[ballQposAdr] = 50; qpos[ballQposAdr + 1] = 0; qpos[ballQposAdr + 2] = BALL_RADIUS;
    qpos[ballQposAdr + 3] = 1; qpos[ballQposAdr + 4] = 0; qpos[ballQposAdr + 5] = 0; qpos[ballQposAdr + 6] = 0;
    for (let i = 0; i < 6; i++) qvel[ballDofAdr + i] = 0;
    mujoco.mj_forward(model, data);
    ballActive = false;
  }

  function resetSim() {
    kickRun = null; rollRun = null; pickRun = null; postKickLock = 0;
    recovery = null; fallDebounce = 0; fallenSince = null;
    mode = "walk";
    mujoco.mj_resetDataKeyframe(model, data, standKeyId);
    mujoco.mj_forward(model, data);
    lastAction.fill(0);
    ballActive = false;
    emitMode();
  }
  resetSim();

  function spawnBall() {
    const qpos = data.qpos, qvel = data.qvel;
    const yaw = Math.atan2(
      2 * (qpos[3] * qpos[6] + qpos[4] * qpos[5]),
      1 - 2 * (qpos[5] * qpos[5] + qpos[6] * qpos[6]),
    );
    const heading = yaw + (Math.random() - 0.5) * 0.7;
    const dist = 0.35 + (Math.random() - 0.5) * 0.1;
    const lim = FENCE_HALF - BALL_RADIUS - 0.05;
    const clamp = (v) => Math.min(lim, Math.max(-lim, v));
    qpos[ballQposAdr] = clamp(qpos[0] + Math.cos(heading) * dist);
    qpos[ballQposAdr + 1] = clamp(qpos[1] + Math.sin(heading) * dist);
    qpos[ballQposAdr + 2] = BALL_RADIUS + 0.02;
    qpos[ballQposAdr + 3] = 1; qpos[ballQposAdr + 4] = 0; qpos[ballQposAdr + 5] = 0; qpos[ballQposAdr + 6] = 0;
    for (let i = 0; i < 6; i++) qvel[ballDofAdr + i] = 0;
    mujoco.mj_forward(model, data);
    ballActive = true;
  }

  // ── Observation ───────────────────────────────────────────────────────
  const _q = new THREE.Quaternion();
  const _g = new THREE.Vector3();
  function projGravZ() {
    const xq = data.body(trunkId).xquat; // [w, x, y, z]
    _q.set(xq[1], xq[2], xq[3], xq[0]).conjugate();
    _g.set(0, 0, -1).applyQuaternion(_q);
    return _g.z;
  }
  function buildObs() {
    const qpos = data.qpos, qvel = data.qvel, sens = data.sensordata;
    let i = 0;
    for (let a = 0; a < 3; a++) obs[i++] = sens[gyroAdr + a];
    const xq = data.body(trunkId).xquat;
    _q.set(xq[1], xq[2], xq[3], xq[0]).conjugate();
    _g.set(0, 0, -1).applyQuaternion(_q);
    obs[i++] = _g.x; obs[i++] = _g.y; obs[i++] = _g.z;
    for (let j = 0; j < NUM_JOINTS; j++) obs[i++] = qpos[qposAdr[j]] - DEFAULT_POSE[j];
    for (let j = 0; j < NUM_JOINTS; j++) obs[i++] = qvel[dofAdr[j]];
    for (let j = 0; j < NUM_JOINTS; j++) obs[i++] = lastAction[j];
    cmd.fill(0);
    if (mode === "groundpick" && pickRun) {
      // Phase encoding in the vel slots; head/body slots stay zero-padded
      // (the runtime's zero_command_padding).
      const a = 2 * Math.PI * pickRun.phase;
      cmd[0] = Math.cos(a);
      cmd[1] = Math.sin(a);
    } else {
      const c = effectiveCmd();
      cmd[0] = c[0]; cmd[1] = c[1]; cmd[2] = c[2];
    }
    for (let c2 = 0; c2 < CMD_SIZE; c2++) obs[i++] = cmd[c2];
    return obs;
  }

  const activeSession = () =>
    recovery?.state === "recovering" ? sessions.stand : sessions[mode];

  function poseIsDead() {
    const z = data.qpos[2];
    const gz = projGravZ();
    if (!Number.isFinite(z) || !Number.isFinite(gz)) return "exploded";
    if (gz > -0.5 || z < 0.02) return "fallen";
    return null;
  }

  async function controlStep() {
    if (recovery?.state !== "fallen") {
      const feeds = { obs: new ort.Tensor("float32", buildObs(), [1, OBS_SIZE]) };
      const out = await activeSession().run(feeds);
      const act = out.actions.data;
      lastAction.set(act);
      const ctrl = data.ctrl;
      for (let j = 0; j < NUM_JOINTS; j++) ctrl[j] = DEFAULT_POSE[j] + act[j] * ACTION_SCALE;
    }
    for (let s = 0; s < DECIMATION; s++) mujoco.mj_step(model, data);

    const death = poseIsDead();
    if (death === "exploded") {
      resetSim();
    } else if (recovery) {
      recovery.steps++;
      if (recovery.state === "fallen") {
        if (recovery.steps >= FALL_SETTLE_STEPS) {
          recovery = { state: "recovering", steps: 0, uprightSteps: 0 };
          lastAction.fill(0);
        }
      } else {
        recovery.uprightSteps = projGravZ() < -0.85 ? recovery.uprightSteps + 1 : 0;
        if (recovery.uprightSteps >= RECOVER_UPRIGHT_STEPS) {
          recovery = null;
          mode = "walk";
          lastAction.fill(0);
          emitMode();
        } else if (recovery.steps >= RECOVER_GIVEUP_STEPS) {
          resetSim();
        }
      }
    } else if (death === "fallen") {
      if (mode === "walk" && postKickLock === 0) {
        fallenSince = null;
        if (++fallDebounce >= FALL_DEBOUNCE_STEPS) {
          fallDebounce = 0;
          recovery = { state: "fallen", steps: 0 };
          emitMode();
        }
      } else {
        fallDebounce = 0;
        const now = performance.now();
        const graceMs = mode === "roll" ? 5000 : 1000;
        fallenSince ??= now;
        if (now - fallenSince > graceMs) resetSim();
      }
    } else {
      fallDebounce = 0;
      fallenSince = null;
    }

    // Ball escape watchdog.
    if (ballActive) {
      const q = data.qpos;
      if (Math.abs(q[ballQposAdr]) > FENCE_HALF + 0.1 ||
          Math.abs(q[ballQposAdr + 1]) > FENCE_HALF + 0.1) spawnBall();
    }

    if (postKickLock > 0 && mode === "walk") postKickLock--;

    if (isKick() && kickRun) {
      kickRun.steps++;
      if (kickRun.steps >= KICK_STEPS) {
        kickRun = null;
        mode = "walk";
        postKickLock = POST_KICK_LOCK_STEPS;
        emitMode();
      }
    }

    // Ground-pick one-shot: advance the trained phase clock and hand back
    // to walk at the runtime's cycle end (~2.8 s).
    if (mode === "groundpick" && pickRun) {
      pickRun.phase += CTRL_DT / GROUND_PICK_PERIOD_S;
      if (pickRun.phase >= GROUND_PICK_END_PHASE) {
        pickRun = null;
        mode = "walk";
        emitMode();
      }
    }

    if (mode === "roll" && rollRun) {
      rollRun.steps++;
      if (obs[5] > -0.3) rollRun.tipped = true;
      const upright = obs[5] < -0.85;
      const done = rollRun.tipped && upright && rollRun.steps >= 40;
      const expired = rollRun.steps >= 150;
      if (done || expired) {
        rollRun = null;
        mode = "walk";
        lastAction.fill(0);
        if (!upright) resetSim();
        emitMode();
      }
    }
  }

  // ── 50 Hz control loop ────────────────────────────────────────────────
  let running = true;
  let ctrlHz = 0;
  (async function controlLoop() {
    let next = performance.now();
    let count = 0, hzT0 = next;
    while (running) {
      if (!paused) {
        await controlStep();
        count++;
      }
      const now = performance.now();
      if (now - hzT0 > 500) {
        ctrlHz = (count * 1000) / (now - hzT0);
        count = 0; hzT0 = now;
      }
      next += CTRL_DT * 1000;
      const wait = next - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else next = performance.now();
    }
  })();

  function triggerKick(foot) {
    if (mode !== "walk" || recovery || postKickLock > 0) return false;
    mode = foot === "left" ? "kickL" : "kickR";
    kickRun = { steps: 0 };
    emitMode();
    return true;
  }

  function triggerRoll() {
    if (mode !== "walk" || recovery) return false;
    mode = "roll";
    rollRun = { steps: 0, tipped: false };
    emitMode();
    return true;
  }

  function triggerGroundPick() {
    if (mode !== "walk" || recovery || postKickLock > 0) return false;
    mode = "groundpick";
    pickRun = { phase: 0 };
    emitMode();
    return true;
  }

  step("ready");
  return {
    model, data, mujoco,
    qposAdr,
    ballQposAdr,
    get ballActive() { return ballActive; },
    get mode() { return recovery ? "recovery" : mode; },
    get ctrlHz() { return ctrlHz; },
    get paused() { return paused; },
    set paused(v) { paused = v; },
    get pickPhase() { return mode === "groundpick" ? pickRun?.phase ?? null : null; },
    resetSim, spawnBall, parkBallPhysics, triggerKick, triggerRoll, triggerGroundPick,
    onMode: (fn) => listeners.mode.push(fn),
    destroy: () => { running = false; },
  };
}
