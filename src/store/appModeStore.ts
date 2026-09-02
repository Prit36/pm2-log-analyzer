import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AppMode = "pm2" | "mongo";

type AppModeState = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
};

export const useAppModeStore = create<AppModeState>()(
  persist(
    (set, get) => ({
      mode: "pm2",
      setMode: (mode: AppMode) => set({ mode }),
      toggleMode: () => set({ mode: get().mode === "pm2" ? "mongo" : "pm2" }),
    }),
    {
      name: "app-analyzer-mode",
    },
  ),
);
