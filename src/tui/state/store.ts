export type Store<T> = {
  getState(): T;
  setState(update: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },
    setState(update) {
      const partial = typeof update === "function" ? update(state) : update;
      state = { ...state, ...partial };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
