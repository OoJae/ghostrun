// Axis-aligned boxes derived from the placed bundle. Shared by the stub sim (collision), the
// follow camera (occlusion) and the headset's teleport; they live with the controller and camera
// rig in @ghostrun/sim (rig.ts), where the proof's T3h drives the same code.
export { collidersOf, groundBelow, rayBox, type Box } from "@ghostrun/sim/rig";
