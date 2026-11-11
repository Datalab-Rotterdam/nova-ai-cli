import { Box, Text } from "ink";

// Braille rendering of the Nova vector logo: a circle with the Nova star cut out.
const LOGO = [
  "         ⢀⣀⣤⣴⣶⣶⣶⣶⣶⣶⣦⣤⣀⡀",
  "      ⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣦⡀",
  "    ⢠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄",
  "   ⣴⣿⣿⣿⣿⣿⣿⣿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦",
  "  ⣼⣿⣿⣿⣿⣿⣿⣿⡟⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧",
  " ⣸⣿⣿⣿⣿⣿⣿⣿⡿⠁ ⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧",
  "⢀⣿⣿⣿⣿⣿⣿⡿⠋    ⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀",
  "⠸⠿⠿⠟⠛⠛⠉         ⠉⠙⠛⠛⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠇",
  "⢰⣶⣶⣦⣤⣄⣀         ⣀⣠⣤⣤⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⡆",
  "⠈⣿⣿⣿⣿⣿⣿⣷⣄    ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠁",
  " ⢹⣿⣿⣿⣿⣿⣿⣿⣷⡀ ⣰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟",
  "  ⢻⣿⣿⣿⣿⣿⣿⣿⣧⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿",
  "   ⠻⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟",
  "    ⠘⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠋",
  "      ⠈⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠁",
  "         ⠈⠙⠛⠻⠿⠿⠿⠿⠿⠿⠟⠛⠋⠁",
] as const;

// The embedded terminal uses slightly taller character cells.
const DESKTOP_LOGO = [
  "          ⣀⣠⣤⣴⣶⣶⣶⣶⣶⣶⣦⣤⣄⣀",
  "      ⢀⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣄⡀",
  "    ⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀",
  "   ⣰⣿⣿⣿⣿⣿⣿⣿⡿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆",
  "  ⣼⣿⣿⣿⣿⣿⣿⣿⣿⠇⢹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧",
  " ⣸⣿⣿⣿⣿⣿⣿⣿⣿⠏  ⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣇",
  " ⣿⣿⣿⣿⣿⣿⣿⠟⠃    ⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  "⠸⠿⠿⠿⠛⠛⠉⠁         ⠉⠙⠛⠛⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠇",
  "⢰⣶⣶⣶⣤⣤⣀          ⣀⣠⣤⣤⣴⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⣶⡆",
  " ⣿⣿⣿⣿⣿⣿⣿⣦⡄    ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
  " ⢹⣿⣿⣿⣿⣿⣿⣿⣿⣆  ⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏",
  "  ⢻⣿⣿⣿⣿⣿⣿⣿⣿⡆⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟",
  "   ⠹⣿⣿⣿⣿⣿⣿⣿⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏",
  "    ⠈⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁",
  "      ⠈⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠋⠁",
  "          ⠉⠙⠛⠿⠿⠿⠿⠿⠿⠿⠿⠛⠋⠉",
] as const;

/** Decorative only: leave room for the header, input and conversation. */
export function WelcomeLogo({ columns, rows }: { columns: number; rows: number }) {
  if (columns < 96 || rows < 22) return null;
  const logo = process.env.NOVA_TERMINAL === "desktop" ? DESKTOP_LOGO : LOGO;
  const width = process.env.NOVA_TERMINAL === "desktop" ? 34 : 32;
  return (
    <Box position="absolute" top={Math.max(5, Math.floor((rows - logo.length) / 2))} left={Math.floor((columns - width) / 2)} flexDirection="column">
      {logo.map((line, index) => <Text key={index} color="#39404a">{line}</Text>)}
    </Box>
  );
}
