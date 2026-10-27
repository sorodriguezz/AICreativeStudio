export const DOMAIN_LABEL: Record<string, string> = {
  create: "Generación creativa",
  edit: "Edición",
  enhance: "Mejora",
  restore: "Restauración",
  brand: "Branding",
  photo: "Fotografía",
};

export const TASK_LABEL: Record<string, string> = {
  text_to_image: "Texto a imagen",
  image_to_image: "Imagen a imagen",
  logo_design: "Diseño de logo",
  upscale: "Super-resolución",
  vectorize: "Vectorización",
  background_replace: "Cambio de fondo",
  recolor: "Recolor",
  pose_change: "Cambio de pose",
  relight: "Reiluminación",
  denoise: "Reducción de ruido",
  face_restore: "Restauración facial",
  scratch_removal: "Limpieza de rayas",
  outpaint: "Extender imagen",
  style_transfer: "Cambio de estilo",
  object_remove: "Quitar objetos",
  object_add: "Agregar objetos",
  inpainting: "Inpainting",
  segmentation: "Segmentación",
  background_removal: "Quitar fondo",
  pose_estimation: "Estimación de pose",
  depth: "Profundidad",
  erase: "Borrar",
  colorize: "Coloreado",
  identity_preservation: "Preservar identidad",
};

export const OPERATION_LABEL: Record<string, string> = {
  auto: "Automático",
  text_to_image: "Generada",
  image_to_image: "Transformar",
  inpainting: "Pintar zona",
  background_replace: "Cambiar fondo",
  background_removal: "Quitar fondo",
  upscale: "Ampliada",
  relight: "Reiluminada",
  vectorize: "Vectorizada (SVG)",
  portrait_retouch: "Retoque",
  identity_generate: "Sesión con identidad",
  pose_change: "Cambio de pose",
  denoise: "Sin ruido",
  face_restore: "Rostros restaurados",
  erase: "Borrar",
  outpaint: "Extendida",
  restore: "Restaurada",
  import: "Original",
};

export const STATUS_LABEL: Record<string, string> = {
  queued: "En cola",
  running: "Generando",
  completed: "Listo",
  failed: "Error",
  cancelled: "Cancelado",
  rejected: "Rechazado",
};

export const PROFILE_LABEL: Record<string, string> = {
  full: "Full",
  balanced: "Balanced",
  compatible: "Compatible",
};

export const ASPECTS = ["1:1", "4:5", "3:4", "2:3", "3:2", "4:3", "16:9", "9:16"];

export const label = (map: Record<string, string>, key: string) => map[key] ?? key;

export const AUDIT_LABEL: Record<string, string> = {
  persona_creada: "Persona registrada",
  persona_eliminada: "Persona eliminada",
  referencia_agregada: "Foto de referencia agregada",
  referencia_eliminada: "Foto de referencia eliminada",
  imagen_eliminada: "Imagen con su identidad eliminada",
  trabajo_con_identidad: "Trabajo con su identidad",
};
