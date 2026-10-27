import { useEffect, useState } from "react";
import { api } from "./api";

/** Quién genera las imágenes: el motor local o la CLI de una suscripción. */
export type ImageProvider = "local" | "codex" | "gemini";
/** Quién mejora los prompts antes de generar (opcional). */
export type PromptProvider = "none" | "claude" | "codex" | "gemini";

export const PROVIDER_SHORT: Record<string, string> = { local: "local", codex: "ChatGPT", gemini: "Gemini", claude: "Claude" };

const CHANGED = "aics:provider-changed";

export async function setProvider(kind: "images" | "prompts", value: string): Promise<void> {
  await api.setSetting(`provider.${kind}`, value);
  window.dispatchEvent(new CustomEvent(CHANGED));
}

export function useProviderSetting(): { images: ImageProvider; prompts: PromptProvider } {
  const [value, setValue] = useState<{ images: ImageProvider; prompts: PromptProvider }>({ images: "local", prompts: "none" });
  useEffect(() => {
    const load = () =>
      Promise.all([api.getSetting("provider.images"), api.getSetting("provider.prompts")])
        .then(([images, prompts]) => setValue({ images: (images as ImageProvider) || "local", prompts: (prompts as PromptProvider) || "none" }))
        .catch(() => undefined);
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, []);
  return value;
}
