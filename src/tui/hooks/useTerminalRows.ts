import { useStdout } from "ink";
import { useEffect, useState } from "react";

export function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows ?? 24);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows ?? 24);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return rows;
}
