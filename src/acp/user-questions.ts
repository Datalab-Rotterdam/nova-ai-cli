import type * as acp from "@agentclientprotocol/sdk";
import type {
  UserInputRequest,
  UserInputResponse,
  UserQuestion,
  UserQuestionOption,
} from "../core/user-questions.js";

export const OTHER_OPTION_ID = "__other__";
const OTHER_SUFFIX = "__other_text";
const QUESTION_META = "nova-ai-cli/question";
const DESCRIPTION_META = "nova-ai-cli/description";
const RECOMMENDED_META = "nova-ai-cli/recommended";
const CUSTOM_META = "nova-ai-cli/custom-answer";

export function toElicitationRequest(
  request: UserInputRequest,
  sessionId: string,
  toolCallId: string,
): acp.CreateElicitationRequest {
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  const required: string[] = [];

  for (const question of request.questions) {
    const options = [
      ...question.options.map(toEnumOption),
      {
        const: OTHER_OPTION_ID,
        title: "Other...",
        _meta: { [CUSTOM_META]: true },
      },
    ];
    const common = {
      title: question.question,
      description: question.description,
      _meta: { [QUESTION_META]: true },
    };
    properties[question.id] =
      question.type === "multiple"
        ? {
            type: "array",
            ...common,
            minItems: 1,
            items: { anyOf: options },
          }
        : {
            type: "string",
            ...common,
            oneOf: options,
          };
    properties[otherKey(question.id)] = {
      type: "string",
      title: `Your own answer for: ${question.question}`,
      description: "Complete this field when choosing Other.",
      minLength: 1,
      _meta: { [CUSTOM_META]: true },
    };
    required.push(question.id);
  }

  return {
    mode: "form",
    sessionId,
    toolCallId,
    message: request.message,
    requestedSchema: {
      type: "object",
      title: "Questions from Nova AI",
      description: request.message,
      properties,
      required,
    },
  };
}

export function fromElicitationRequest(
  request: acp.CreateElicitationRequest,
): UserInputRequest | null {
  if (request.mode !== "form") return null;
  const questions = Object.entries(
    request.requestedSchema.properties ?? {},
  ).flatMap(([id, property]) => {
    if (property._meta?.[QUESTION_META] !== true) return [];
    const options = enumOptions(property).flatMap(fromEnumOption);
    if (!property.title || options.length === 0) return [];
    return [
      {
        id,
        question: property.title,
        ...(property.description ? { description: property.description } : {}),
        type: property.type === "array" ? "multiple" : "single",
        options,
      } satisfies UserQuestion,
    ];
  });
  return questions.length ? { message: request.message, questions } : null;
}

export function toElicitationResponse(
  request: UserInputRequest,
  response: UserInputResponse,
): acp.CreateElicitationResponse {
  if (response.action !== "accept") return { action: response.action };
  const content: Record<string, acp.ElicitationContentValue> = {};
  for (const answer of response.answers) {
    const question = request.questions.find(
      (item) => item.id === answer.questionId,
    );
    content[answer.questionId] =
      question?.type === "multiple"
        ? answer.selectedOptionIds
        : (answer.selectedOptionIds[0] ?? "");
    if (answer.customAnswer) {
      content[otherKey(answer.questionId)] = answer.customAnswer;
    }
  }
  return { action: "accept", content };
}

export function fromElicitationResponse(
  request: UserInputRequest,
  response: acp.CreateElicitationResponse,
): UserInputResponse {
  if (response.action !== "accept") {
    return { action: response.action, answers: [] };
  }
  return {
    action: "accept",
    answers: request.questions.map((question) => {
      const value = response.content?.[question.id];
      const selectedOptionIds = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [];
      const custom = response.content?.[otherKey(question.id)];
      return {
        questionId: question.id,
        selectedOptionIds,
        customAnswer:
          typeof custom === "string" && custom.trim()
            ? custom.trim()
            : undefined,
      };
    }),
  };
}

function toEnumOption(option: UserQuestionOption): acp.EnumOption {
  return {
    const: option.id,
    title: `${option.label}${option.recommended ? " (Recommended)" : ""}`,
    _meta: {
      ...(option.description ? { [DESCRIPTION_META]: option.description } : {}),
      ...(option.recommended ? { [RECOMMENDED_META]: true } : {}),
    },
  };
}

function fromEnumOption(option: acp.EnumOption): UserQuestionOption[] {
  if (option.const === OTHER_OPTION_ID || option._meta?.[CUSTOM_META] === true)
    return [];
  const recommended = option._meta?.[RECOMMENDED_META] === true;
  const recommendedSuffix = /\s+\(Recommended\)$/;
  return [
    {
      id: option.const,
      label: option.title.replace(recommendedSuffix, ""),
      ...(typeof option._meta?.[DESCRIPTION_META] === "string"
        ? { description: option._meta[DESCRIPTION_META] }
        : {}),
      ...(recommended ? { recommended: true } : {}),
    },
  ];
}

function enumOptions(
  property: acp.ElicitationPropertySchema,
): acp.EnumOption[] {
  if (property.type === "string") return property.oneOf ?? [];
  if (property.type !== "array") return [];
  return "anyOf" in property.items ? property.items.anyOf : [];
}

function otherKey(questionId: string): string {
  return `${questionId}${OTHER_SUFFIX}`;
}
