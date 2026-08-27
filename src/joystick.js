// Floating analog stick + action buttons, adapted from the playground's
// touch source. The stick base re-anchors under the finger wherever it
// lands inside #touch-zone, and snaps back on release. Vertical = vx
// (asymmetric fwd/back limits), horizontal = turn. EMA-smoothed so
// releases don't snap the command.

const TOUCH_ALPHA = 0.18;
const TOUCH_DEADZONE = 0.12;

export class Joystick {
  command = new Float32Array(3); // [vx, 0, wz], EMA-smoothed
  #target = [0, 0];
  #limits;

  constructor({ zone, stick, nub, limits }) {
    this.#limits = limits; // [fwd, back, ang]
    let pointerId = null;
    let center = null;
    const setFrom = (e) => {
      const zr = zone.getBoundingClientRect();
      const R = stick.offsetWidth / 2;
      const travel = R * 0.62;
      let dx = e.clientX - zr.left - center.x;
      let dy = e.clientY - zr.top - center.y;
      const d = Math.hypot(dx, dy);
      if (d > travel) { dx *= travel / d; dy *= travel / d; }
      nub.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / travel, ny = -dy / travel;
      const live = Math.hypot(nx, ny) >= TOUCH_DEADZONE;
      this.#target[0] = live ? nx : 0;
      this.#target[1] = live ? ny : 0;
    };
    const release = () => {
      pointerId = null;
      center = null;
      stick.classList.remove("live");
      nub.style.transform = "";
      stick.style.left = "";
      stick.style.top = "";
      stick.style.bottom = "";
      this.#target[0] = 0;
      this.#target[1] = 0;
    };
    zone.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pointerId = e.pointerId;
      const zr = zone.getBoundingClientRect();
      const R = stick.offsetWidth / 2;
      center = { x: e.clientX - zr.left, y: e.clientY - zr.top };
      stick.style.left = `${center.x - R}px`;
      stick.style.top = `${center.y - R}px`;
      stick.style.bottom = "auto";
      stick.classList.add("live");
      setFrom(e);
      try { zone.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId === pointerId) setFrom(e);
    });
    zone.addEventListener("pointerup", (e) => { if (e.pointerId === pointerId) release(); });
    zone.addEventListener("pointercancel", (e) => { if (e.pointerId === pointerId) release(); });
  }

  poll() {
    const [x, y] = this.#target;
    const [limF, limB, limA] = this.#limits;
    const tvx = y >= 0 ? y * limF : y * -limB;
    const twz = -x * limA;
    this.command[0] += TOUCH_ALPHA * (tvx - this.command[0]);
    this.command[2] += TOUCH_ALPHA * (twz - this.command[2]);
    if (Math.abs(this.command[0]) + Math.abs(this.command[2]) < 0.005 &&
        this.#target[0] === 0 && this.#target[1] === 0) {
      this.command[0] = 0;
      this.command[2] = 0;
    }
  }
}

// Round action cap: fires on the press edge, tracks held state.
export function bindButton(el, onPress, onRelease = () => {}) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.classList.add("down");
    onPress();
    try { el.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  });
  const release = () => { el.classList.remove("down"); onRelease(); };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
}
