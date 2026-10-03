/** Option id for the free-text "Other" answer, shared by every client. */
export const OTHER_OPTION_ID = "__other__";

export type UserQuestionType = "single" | "multiple";

export type UserQuestionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type UserQuestion = {
  id: string;
  question: string;
  description?: string;
  type: UserQuestionType;
  options: UserQuestionOption[];
};

export type UserInputRequest = {
  message: string;
  questions: UserQuestion[];
};

export type UserQuestionAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  customAnswer?: string;
};

export type UserInputResponse = {
  action: "accept" | "decline" | "cancel";
  answers: UserQuestionAnswer[];
};
