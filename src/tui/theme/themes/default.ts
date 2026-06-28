export type Theme = {
  name: string;
  primary: string;
  secondary: string;
  muted: string;
  success: string;
  error: string;
  warning: string;
  border: string;
  diffAdded: string;
  diffRemoved: string;
};

export const defaultTheme: Theme = {
  name: "default",
  primary: "#6f27f5",
  secondary: "#c200c2",
  muted: "#808080",
  success: "#5fb85f",
  error: "#e05858",
  warning: "#e0c158",
  border: "#2d2d2d",
  diffAdded: "#5fb85f",
  diffRemoved: "#e05858",
};
