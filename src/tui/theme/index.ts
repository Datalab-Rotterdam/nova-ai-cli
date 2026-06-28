import { createContext, useContext } from "react";
import { defaultTheme, type Theme } from "./themes/default.js";

export type { Theme };

export const themes: Record<string, Theme> = {
  default: defaultTheme,
};

export function resolveTheme(name: string | undefined): Theme {
  return (name && themes[name]) || defaultTheme;
}

export const ThemeContext = createContext<Theme>(defaultTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
