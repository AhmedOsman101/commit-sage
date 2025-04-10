import type { CommitMessage } from "../index.d.ts";
import { errorMessages } from "../utils/constants.ts";
import { logError } from "../utils/Logger.ts";
import CodestralService from "./codestralService.ts";
import ConfigService from "./configService.ts";
import GeminiService from "./geminiService.ts";
import GitBlameAnalyzer from "./gitBlameAnalyzer.ts";
import GitService from "./gitService.ts";
import OllamaService from "./ollamaService.ts";
import OpenAIService from "./openaiService.ts";
import PromptService from "./promptService.ts";

const MAX_DIFF_LENGTH = 100000;

const AiService = {
  truncateDiff(diff: string): string {
    return diff.length > MAX_DIFF_LENGTH
      ? `${diff.substring(0, MAX_DIFF_LENGTH)}\n...(truncated)`
      : diff;
  },

  async generateCommitMessage(
    diff: string,
    blameAnalysis: string
  ): Promise<CommitMessage> {
    if (!diff) {
      throw new Error(errorMessages.noChanges);
    }

    const truncatedDiff = this.truncateDiff(diff);
    const prompt = PromptService.generatePrompt(truncatedDiff, blameAnalysis);

    try {
      const provider = ConfigService.get("provider", "type");
      let result: CommitMessage;

      switch (provider) {
        case "openai":
          result = await OpenAIService.generateCommitMessage(prompt);
          break;
        case "codestral":
          result = await CodestralService.generateCommitMessage(prompt);
          break;
        case "ollama":
          result = await OllamaService.generateCommitMessage(prompt);
          break;
        case "gemini":
          result = await GeminiService.generateCommitMessage(prompt);
          break;
      }

      return result;
    } catch (error) {
      void logError("Failed to generate commit message:", error as Error);

      throw error;
    }
  },
  async generateAndApplyMessage() {
    await GitService.initialize();
    const onlyStagedSetting = ConfigService.get("commit", "onlyStagedChanges");
    const hasStagedChanges = await GitService.hasChanges("staged");

    const useStagedChanges = onlyStagedSetting || hasStagedChanges;

    const diff = await GitService.getDiff(useStagedChanges);

    if (!diff) logError("No changes to commit");

    const changedFiles = await GitService.getChangedFiles(useStagedChanges);

    const blameAnalyses: Awaited<
      ReturnType<typeof GitBlameAnalyzer.analyzeChanges>
    >[] = [];

    for (const file of changedFiles) {
      // biome-ignore lint/nursery/noAwaitInLoop: <explanation>
      const analysisResult = await GitBlameAnalyzer.analyzeChanges(file);
      blameAnalyses.push(analysisResult);
    }

    const blameAnalysis = blameAnalyses
      .filter(analysis => analysis)
      .join("\n\n");

    const commitMessage = await this.generateCommitMessage(diff, blameAnalysis);

    // TODO: implement auto commit
    // if (ConfigService.getAutoCommitEnabled()) {
    //   await CommitMessageUI.handleAutoCommit();
    // }

    return commitMessage;
  },
};

export default AiService;
