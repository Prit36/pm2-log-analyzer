# React & State Architecture Rules

## 1. Action Extraction & Zustand Store Usage
- **Module-Level Action Extraction**: Do not export individual action functions from store files. In consuming components and modules, extract action methods at module scope:
  ```ts
  const { setFilters, showToast, clearAnalysis } = useAnalysisStore.getState();
  ```
- **No Inline Hook Selectors for Actions**: Avoid `const setFilters = useStore((s) => s.setFilters)` because action function references in Zustand are permanent and never change.
- **No Inline `getState()` Call Spam**: Avoid writing `useStore.getState().action(...)` repeatedly inside JSX handlers. Extract them once at the top of the module.

## 2. Standalone Operational Functions
- Define operational logic, parser routines (`parseFile`, `parseFiles`, `parseText`, `reaggregate`, `cancel`, `clear`), export generators (`exportSpreadsheetData`), clipboard helpers (`copyApiPath`, `copyCronTsv`), and table sorters outside React components and hooks as pure standalone exported functions.
- Event handlers call these standalone functions directly.

## 3. Zero `useEffect` for Operations, Lifecycles, and Subscriptions
- **Singletons**: Initialize long-lived singletons (like web workers) directly at module evaluation time (`getOrCreateWorker()`), not in `useEffect(..., [])`.
- **DOM Updates**: Apply DOM mutations (such as `document.documentElement.classList.toggle("dark", ...)`) directly inside the store actions (`toggleTheme()`, `setTheme()`), not in reactive store subscriptions or `useEffect`.
- **Operational Consequences**: When a user action requires a background worker operation (e.g. changing a filter that necessitates `reaggregate()`), invoke the operation directly in the event handler alongside the store update. Do not create store `subscribe` loops, debouncing timeouts, or synthetic listener registration patterns (`onWorkerFilterChange`).

## 4. Grouped Multi-Property State Selectors
- When a component requires multiple reactive state properties, use a single `useShallow` selector:
  ```tsx
  const { query, statusFamily, minMs } = useAnalysisStore(
    useShallow((s) => ({
      query: s.filters.query,
      statusFamily: s.filters.statusFamily,
      minMs: s.filters.minMs,
    }))
  );
  ```

## 5. On-Demand Snapshot Reads
- For values needed solely when an event executes (such as current sort direction or table rows during copy), read them on demand via `useStore.getState().prop` rather than subscribing the component to them.

## 6. Anti-Slop Guidelines
- In browser SPA environments, do not check `typeof window !== "undefined"` or `typeof document !== "undefined"`. Access `window` and `document` directly.
- Avoid artificial timer debounces and intermediate wrapper abstractions when direct calls execute in <5ms.
