import { ProcessTerminal } from "@earendil-works/pi-tui";

const ENTER_FULLSCREEN = "\u001b[?1049h\u001b[2J\u001b[H";
const LEAVE_FULLSCREEN = "\u001b[?1049l";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";

/** Process terminal configured as a full-screen application viewport. */
export class FullscreenProcessTerminal extends ProcessTerminal {
  private fullscreen = false;

  override start(onInput: (data: string) => void, onResize: () => void): void {
    if (!this.fullscreen) {
      this.write(`${ENTER_FULLSCREEN}${ENABLE_MOUSE}`);
      this.fullscreen = true;
    }
    super.start(onInput, onResize);
  }

  override stop(): void {
    if (this.fullscreen) this.write(DISABLE_MOUSE);
    super.stop();
    if (this.fullscreen) {
      this.write(LEAVE_FULLSCREEN);
      this.fullscreen = false;
    }
  }
}
