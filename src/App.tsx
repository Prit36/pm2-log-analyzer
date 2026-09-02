import { useAppModeStore } from "./store/appModeStore";
import { AppHeader } from "./components/AppHeader";
import { Pm2AppView } from "./components/Pm2AppView";
import { MongoAppView } from "./components/mongo/MongoAppView";
import { Toast } from "./components/Toast";

export function App() {
  const mode = useAppModeStore((s) => s.mode);

  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
        {mode === "mongo" ? <MongoAppView /> : <Pm2AppView />}
      </main>
      <Toast />
    </div>
  );
}

export default App;
