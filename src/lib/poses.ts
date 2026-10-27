import type { PoseData } from "./api";

/**
 * Biblioteca de poses (OpenPose-18, normalizadas sobre un lienzo 3:4).
 * Orden: nariz, cuello, hombro D, codo D, muñeca D, hombro I, codo I, muñeca I,
 * cadera D, rodilla D, tobillo D, cadera I, rodilla I, tobillo I, ojo D, ojo I, oreja D, oreja I.
 * "D" es la derecha de la persona (aparece a la izquierda de la imagen).
 */
type P = [number, number];

export const JOINT_NAMES = ["Nariz", "Cuello", "Hombro der.", "Codo der.", "Muñeca der.", "Hombro izq.", "Codo izq.", "Muñeca izq.",
  "Cadera der.", "Rodilla der.", "Tobillo der.", "Cadera izq.", "Rodilla izq.", "Tobillo izq.", "Ojo der.", "Ojo izq.", "Oreja der.", "Oreja izq."];

export const LIMBS: [number, number][] = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
export const COLORS = ["#ff0000", "#ff5500", "#ffaa00", "#ffff00", "#aaff00", "#55ff00", "#00ff00", "#00ff55", "#00ffaa", "#00ffff", "#00aaff", "#0055ff", "#0000ff", "#5500ff", "#aa00ff", "#ff00ff", "#ff00aa", "#ff0055"];

const BASE: P[] = [
  [0.5, 0.16], [0.5, 0.25], [0.4, 0.26], [0.37, 0.4], [0.36, 0.53], [0.6, 0.26], [0.63, 0.4], [0.64, 0.53],
  [0.45, 0.53], [0.45, 0.71], [0.45, 0.89], [0.55, 0.53], [0.55, 0.71], [0.55, 0.89], [0.48, 0.145], [0.52, 0.145], [0.46, 0.155], [0.54, 0.155],
];

const variant = (changes: Record<number, P>): P[] => BASE.map((p, i) => changes[i] ?? p);

export const POSES: { id: string; label: string; points: P[] }[] = [
  { id: "frontal", label: "De pie, frontal", points: BASE },
  { id: "cintura", label: "Manos en la cintura", points: variant({ 3: [0.32, 0.38], 4: [0.43, 0.5], 6: [0.68, 0.38], 7: [0.57, 0.5] }) },
  { id: "cruzados", label: "Brazos cruzados", points: variant({ 3: [0.4, 0.41], 4: [0.58, 0.37], 6: [0.6, 0.41], 7: [0.42, 0.37] }) },
  {
    id: "contrapposto", label: "Contrapposto",
    points: variant({ 0: [0.51, 0.165], 14: [0.49, 0.15], 15: [0.53, 0.15], 16: [0.47, 0.16], 17: [0.55, 0.16], 2: [0.4, 0.265], 5: [0.6, 0.255], 8: [0.45, 0.54], 11: [0.56, 0.52], 9: [0.47, 0.72], 10: [0.47, 0.9], 12: [0.6, 0.7], 13: [0.63, 0.88], 4: [0.38, 0.54], 7: [0.62, 0.5], 6: [0.65, 0.38] }),
  },
  { id: "caminando", label: "Caminando", points: variant({ 3: [0.38, 0.39], 4: [0.42, 0.51], 6: [0.62, 0.4], 7: [0.6, 0.52], 9: [0.43, 0.7], 10: [0.4, 0.88], 12: [0.57, 0.72], 13: [0.6, 0.89] }) },
  { id: "saludo", label: "Brazo en alto", points: variant({ 3: [0.33, 0.19], 4: [0.32, 0.08] }) },
  { id: "menton", label: "Mano en el mentón", points: variant({ 6: [0.6, 0.41], 7: [0.51, 0.205] }) },
  {
    id: "tres-cuartos", label: "Tres cuartos",
    points: variant({ 0: [0.53, 0.16], 14: [0.51, 0.145], 15: [0.55, 0.145], 16: [0.5, 0.155], 17: [0.57, 0.16], 2: [0.43, 0.26], 5: [0.59, 0.27], 3: [0.41, 0.4], 4: [0.42, 0.53], 6: [0.61, 0.41], 7: [0.6, 0.53], 8: [0.47, 0.53], 11: [0.56, 0.53], 9: [0.47, 0.71], 12: [0.56, 0.71], 10: [0.47, 0.89], 13: [0.57, 0.89] }),
  },
];

export const poseData = (points: P[]): PoseData => ({ width: 768, height: 1024, body: points.map(([x, y]) => [x, y, 1]) });

/** Espejo horizontal: intercambia izquierda y derecha. */
export function mirror(pose: PoseData): PoseData {
  const swap = [0, 1, 5, 6, 7, 2, 3, 4, 11, 12, 13, 8, 9, 10, 15, 14, 17, 16];
  return { ...pose, body: swap.map((j) => { const [x, y, c] = pose.body[j]; return [c > 0 ? 1 - x : x, y, c]; }), hands: pose.hands ? [pose.hands[1], pose.hands[0]].map((h) => h.map(([x, y, c]) => [1 - x, y, c] as [number, number, number])) : undefined };
}
