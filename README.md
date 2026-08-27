---
title: Microduck AR
emoji: 🐤
colorFrom: yellow
colorTo: gray
sdk: static
app_build_command: npm run build
app_file: dist/index.html
short_description: The Microduck RL sim on your real floor, in web AR
---

# Microduck AR

The [Microduck](https://huggingface.co/spaces/pollen-robotics/microduck-simulator)
robot walking on **your real floor**: real MuJoCo physics (WebAssembly) +
the real trained RL policies (onnxruntime-web, 50 Hz) inside a WebXR
`immersive-ar` session. Scan the floor, tap to place the ~25 cm duck at
true scale, drive it with a floating stick, kick the ball, quack.

No server: physics, policy inference and rendering all run in the browser.

## AR support

- **Android Chrome** - native WebXR, works out of the box.
- **iPhone / iPad** - Safari has no WebXR. This app integrates
  [Variant Launch](https://launch.variant3d.com): register this domain
  there (free tier), put the key in `window.VL_KEY` in `index.html`, and
  iOS visitors get true ARKit world tracking via an instant App Clip.
- **Anywhere else** - the "3D preview" button runs the identical sim with
  orbit controls.

## Controls (in AR / preview)

- Floating stick (left half of the screen): forward / back + turn
- KICK: one-shot blind kick, alternating feet
- PICK: peck the ground and stand back up
- ROLL: roulade + recover
- QUACK: chirp + beak (hold to keep the beak open)
- BALL: (re)spawn the beach ball in front of the duck
- SIZE: 1x / 2x / 3x visual scale (physics stays true-scale)
- MOVE: re-place the duck on another surface
- Desktop preview: WASD / arrows also steer

If the duck trips, the fall-recovery policy stands it back up on its own.

## Credits

Robot, MJCF model and trained policies by
[Pollen Robotics](https://huggingface.co/pollen-robotics) /
[apirrone](https://github.com/apirrone/microduck_runtime)
([mjlab_microduck](https://github.com/apirrone/mjlab_microduck)).
Sim core adapted from the
[Microduck Sandbox](https://huggingface.co/spaces/pollen-robotics/microduck-simulator) Space.
