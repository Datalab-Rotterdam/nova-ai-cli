import type {
  UserInputRequest,
  UserQuestion,
  UserQuestionOption,
} from "../../core/user-questions.js";
import { OTHER_OPTION_ID } from "../user-questions.js";
import type { ToolDefinition } from "./types.js";

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

export const askUserTool: ToolDefinition = {
  name: "ask_user",
  description:
    'ask_user: {"message":"<why input is needed>","questions":[{"id":"framework","question":"Which framework?","description":"<optional context>","type":"single|multiple","options":[{"id":"svelte","label":"Svelte","description":"<optional tradeoff>","recommended":true}]}]} - ask 1-4 interactive questions. Each question needs 2-6 options, supports single or multiple selection, option descriptions, one recommended option, and an automatic final Other choice where the user can enter a custom answer.',
  isAvailable: ({ caps }) => !!caps?.elicitation?.form,
  mutating: false,
  kind: "think",
  async execute({ host, toolCallId, signal }, args) {
    const parsed = parseRequest(args);
    if ("error" in parsed) return parsed;
    if (!host.requestUserInput) {
      return { error: "This client cannot present interactive questions." };
    }
    const response = await host.requestUserInput(
      parsed.request,
      toolCallId,
      signal,
    );
    if (response.action !== "accept") {
      return {
        output:
          response.action === "decline"
            ? "User declined the question request."
            : "User canceled the question request.",
      };
    }
    return { output: formatAnswers(parsed.request, response.answers) };
  },
};

function parseRequest(
  args: Record<string, unknown>,
): { request: UserInputRequest } | { error: string } {
  if (!Array.isArray(args.questions)) {
    return { error: "ask_user requires a 'questions' array." };
  }
  if (args.questions.length < 1 || args.questions.length > 4) {
    return { error: "ask_user accepts between 1 and 4 questions." };
  }

  const questions: UserQuestion[] = [];
  const questionIds = new Set<string>();
  for (let index = 0; index < args.questions.length; index++) {
    const raw = toRecord(args.questions[index]);
    const id = readString(raw.id);
    const question = readString(raw.question);
    const type = raw.type === "multiple" ? "multiple" : "single";
    if (!id || !ID_PATTERN.test(id)) {
      return {
        error: `Question ${index + 1} needs an id starting with a letter and containing only letters, numbers, '_' or '-'.`,
      };
    }
    if (questionIds.has(id)) {
      return { error: `Question id '${id}' is duplicated.` };
    }
    if (!question) {
      return { error: `Question '${id}' needs non-empty question text.` };
    }
    if (
      !Array.isArray(raw.options) ||
      raw.options.length < 2 ||
      raw.options.length > 6
    ) {
      return { error: `Question '${id}' needs between 2 and 6 options.` };
    }

    const options: UserQuestionOption[] = [];
    const optionIds = new Set<string>();
    let recommendations = 0;
    for (let optionIndex = 0; optionIndex < raw.options.length; optionIndex++) {
      const rawOption = toRecord(raw.options[optionIndex]);
      const optionId = readString(rawOption.id);
      const label = readString(rawOption.label);
      if (
        !optionId ||
        !ID_PATTERN.test(optionId) ||
        optionId === OTHER_OPTION_ID
      ) {
        return {
          error: `Option ${optionIndex + 1} in question '${id}' needs a valid id.`,
        };
      }
      if (optionIds.has(optionId)) {
        return {
          error: `Option id '${optionId}' is duplicated in question '${id}'.`,
        };
      }
      if (!label) {
        return {
          error: `Option '${optionId}' in question '${id}' needs a label.`,
        };
      }
      const recommended = rawOption.recommended === true;
      if (recommended) recommendations++;
      optionIds.add(optionId);
      options.push({
        id: optionId,
        label,
        description: readString(rawOption.description) || undefined,
        recommended,
      });
    }
    if (recommendations > 1) {
      return {
        error: `Question '${id}' can have only one recommended option.`,
      };
    }

    questionIds.add(id);
    questions.push({
      id,
      question,
      description: readString(raw.description) || undefined,
      type,
      options,
    });
  }

  return {
    request: {
      message:
        readString(args.message) || "Nova AI needs your input to continue.",
      questions,
    },
  };
}

function formatAnswers(
  request: UserInputRequest,
  answers: Array<{
    questionId: string;
    selectedOptionIds: string[];
    customAnswer?: string;
  }>,
): string {
  const lines = ["User answers:"];
  for (const question of request.questions) {
    const answer = answers.find((item) => item.questionId === question.id);
    const labels = (answer?.selectedOptionIds ?? []).flatMap((id) => {
      if (id === OTHER_OPTION_ID) return [];
      const option = question.options.find((item) => item.id === id);
      return option ? [option.label] : [id];
    });
    if (answer?.customAnswer) labels.push(answer.customAnswer);
    lines.push(`- ${question.question}: ${labels.join(", ") || "(no answer)"}`);
  }
  return lines.join("\n");
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
