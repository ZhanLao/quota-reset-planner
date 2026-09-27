import { registerSW } from "virtual:pwa-register";

export function registerPwa(onUpdate: () => void, onOfflineReady: () => void): () => Promise<void> {
  return registerSW({ immediate: true, onNeedRefresh: onUpdate, onOfflineReady });
}
