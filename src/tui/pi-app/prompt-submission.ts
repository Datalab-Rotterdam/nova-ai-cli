import type { DraftImageAttachments } from "../files/prompt-images.js";
import type { PromptImageAttachment } from "../files/prompt-images.js";
import type { PromptPasteAttachment } from "../files/prompt-pastes.js";
import type { Store } from "../state/store.js";
import type { UIState } from "../state/types.js";
import type { PromptEditor } from "./prompt-editor.js";

type PromptSubmitRunner = {
  readonly model: string;
  supportsImageInput(): Promise<boolean>;
};

type BindPromptSubmissionOptions = {
  editor: PromptEditor;
  draftImages: DraftImageAttachments;
  runner: PromptSubmitRunner;
  store: Store<UIState>;
  submit(
    text: string,
    images: PromptImageAttachment[],
    pastes: PromptPasteAttachment[],
  ): Promise<void>;
  appendError(text: string): void;
};

/**
 * Connect the editor to the async prompt path without locking it for the whole
 * model turn. The lock only protects attachment validation and draft capture;
 * once the draft has been consumed, later submissions must be able to reach
 * SessionRunner so it can enqueue them.
 */
export function bindPromptSubmission({
  editor,
  draftImages,
  runner,
  store,
  submit,
  appendError,
}: BindPromptSubmissionOptions): void {
  let submissionPending = false;

  editor.onSubmit = (text) => {
    if (submissionPending) return;
    submissionPending = true;
    let ownsSubmissionLock = true;
    const releaseSubmissionLock = () => {
      if (!ownsSubmissionLock) return;
      ownsSubmissionLock = false;
      submissionPending = false;
    };

    void (async () => {
      const images = text.trimStart().startsWith("/")
        ? []
        : draftImages.referencedBy(text);
      const pastes = editor.referencedPastes(text);
      if (images.length > 0 && !(await runner.supportsImageInput())) {
        // Pi's editor clears itself before invoking onSubmit, so explicitly
        // restore a rejected draft along with its retained attachments.
        editor.setText(text);
        store.setState({
          statusLine: `Model ${runner.model} does not support image input; the draft was kept.`,
        });
        return;
      }

      editor.setText("");
      draftImages.clear();
      editor.clearPastes();

      // Calling submit first lets SessionRunner mark the initial turn busy.
      // Releasing immediately afterwards allows the next Enter press through;
      // that call will take SessionRunner's queue branch.
      const completion = submit(text, images, pastes);
      releaseSubmissionLock();
      await completion;
    })()
      .catch((error) => {
        appendError(
          error instanceof Error ? error.message : "Failed to submit input.",
        );
        store.setState({ busy: false, statusLine: "Input failed." });
      })
      .finally(releaseSubmissionLock);
  };
}
