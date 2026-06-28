import { useSyncExternalStore } from "react";
import type { Store } from "../state/store.js";

export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
