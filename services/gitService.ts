import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandOutput, Result } from "../index.d.ts";
import { NoChangesDetectedError } from "../models/errors.ts";
import { logError } from "../utils/Logger.ts";
import CommandService from "./commandService.ts";

const GIT_STATUS_CODES = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "??",
  submodule: "S",
} as const;

type GitStatusCode = (typeof GIT_STATUS_CODES)[keyof typeof GIT_STATUS_CODES];

const STAGED_STATUS_CODES: GitStatusCode[] = [
  GIT_STATUS_CODES.modified,
  GIT_STATUS_CODES.added,
  GIT_STATUS_CODES.deleted,
  GIT_STATUS_CODES.renamed,
];

class GitService {
  static repoPath = "";

  static initialize(): string | undefined {
    const [output, err] = this.getRepoPath();

    if (err !== null) logError(err);
    else {
      this.setRepoPath(output);
      return output;
    }
  }
  static execGit(args: string[]): Result<CommandOutput> {
    const [output, err] = CommandService.execute("git", args, this.repoPath);
    if (err !== null) return [null, err];

    const { stderr, code } = output;

    if (code !== 0)
      return [
        null,
        `Git Command failed with code ${code}${stderr ? `: ${stderr}` : ""}`,
      ];

    return [output, null];
  }
  static calculateFileHash(content: string): string {
    // Simple hash calculation for git index
    const hash = Buffer.from(content).toString("base64");
    return hash.substring(0, 7);
  }
  static hasHead(): boolean {
    const [output, err] = this.execGit(["rev-parse", "HEAD"]);
    if (err !== null) return false;
    return output.code === 0;
  }
  static hasChanges(
    type: "staged" | "unstaged" | "untracked" | "deleted"
  ): boolean {
    let command: string[];
    switch (type) {
      case "staged":
        command = ["diff", "--cached", "--name-only"];
        break;
      case "unstaged":
        command = ["diff", "--name-only"];
        break;
      case "untracked":
        command = ["ls-files", "--others", "--exclude-standard"];
        break;
      case "deleted":
        command = ["ls-files", "--deleted"];
        break;
      default:
        throw new Error(`Invalid change type: ${type}`);
    }

    const [output, err] = this.execGit(command);
    if (err !== null) {
      console.error(`Error checking for ${type} changes`);
      return false;
    }

    return output.stdout.trim().length > 0;
  }
  static isSubmodule(file: string): boolean {
    const [output, err] = this.execGit(["ls-files", "--stage", "--", file]);

    if (err !== null) return false;
    return output.stdout.includes("160000");
  }
  static async getDiff(onlyStagedChanges: boolean): Promise<string> {
    try {
      const hasHead = this.hasHead();

      const hasStagedChanges = this.hasChanges("staged");

      const hasUnstagedChanges = this.hasChanges("unstaged");

      const hasUntrackedFiles = this.hasChanges("untracked");

      const hasDeletedFiles = hasHead && this.hasChanges("deleted");

      if (
        !hasStagedChanges &&
        !hasUnstagedChanges &&
        !hasUntrackedFiles &&
        !hasDeletedFiles
      ) {
        throw new NoChangesDetectedError("No changes detected.");
      }
      const diffs: string[] = [];

      // Skip submodule changes
      // If we only want staged changes and there are some, return only those
      if (onlyStagedChanges && hasStagedChanges) {
        const [output, err] = this.execGit(["diff", "--cached", "--name-only"]);
        if (err !== null) throw new Error(err);

        const { stdout: stagedFiles } = output;

        const stagedFilesArray = stagedFiles
          .split("\n")
          .filter(file => file.trim());

        for (const file of stagedFilesArray) {
          if (!this.isSubmodule(file)) {
            const [output, err] = this.execGit([
              "diff",
              "--cached",
              "--",
              file,
            ]);
            if (err !== null) throw new Error(err);

            const { stdout: fileDiff } = output;

            if (fileDiff.trim()) {
              diffs.push(fileDiff);
            }
          }
        }
        return diffs.join("\n\n").trim();
      }

      // Otherwise, get all changes
      if (hasStagedChanges) {
        const [output, err] = this.execGit(["diff", "--cached", "--name-only"]);
        if (err !== null) throw new Error(`${err} hasStagedChanges`);

        const { stdout: stagedFiles } = output;

        const stagedFilesArray = stagedFiles
          .split("\n")
          .filter(file => file.trim());

        for (const file of stagedFilesArray) {
          if (!this.isSubmodule(file)) {
            const [output, err] = this.execGit([
              "diff",
              "--cached",
              "--",
              file,
            ]);
            if (err !== null)
              throw new Error(`${err} hasStagedChanges ${file} loop`);

            const { stdout: fileDiff } = output;

            if (fileDiff.trim()) {
              diffs.push(`# Staged changes:\n${fileDiff}`);
            }
          }
        }
      }

      if (hasUnstagedChanges) {
        const [output, err] = this.execGit(["diff", "--name-only"]);

        if (err !== null) throw new Error(err);

        const { stdout: unstagedFiles } = output;

        const unstagedFilesArray = unstagedFiles
          .split("\n")
          .filter(file => file.trim());

        for (const file of unstagedFilesArray) {
          if (!this.isSubmodule(file)) {
            const [output, err] = this.execGit(["diff", "--", file]);
            if (err !== null) throw new Error(err);

            const { stdout: fileDiff } = output;

            if (fileDiff.trim()) {
              diffs.push(`# Unstaged changes:\n${fileDiff}`);
            }
          }
        }
      }

      if (hasUntrackedFiles) {
        const [output, err] = this.execGit([
          "ls-files",
          "--others",
          "--exclude-standard",
        ]);

        if (err !== null) throw new Error(err);
        const { stdout: untrackedFiles } = output;

        const untrackedDiff = await Promise.all(
          untrackedFiles
            .split("\n")
            .filter(file => file.trim())
            .map(async file => {
              try {
                // Read the content of the new file
                const content = await fs.promises.readFile(
                  path.join(this.repoPath, file),
                  "utf-8"
                );
                const lines = content.split("\n");
                const contentDiff = lines
                  .map((line: string) => `+${line}`)
                  .join("\n");
                return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..${this.calculateFileHash(content)}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${contentDiff}`;
              } catch (error) {
                void console.error(
                  `Error reading new file ${file}:`,
                  error as Error
                );
                return "";
              }
            })
        );
        const validUntrackedDiffs = untrackedDiff.filter(diff => diff.trim());
        if (validUntrackedDiffs.length > 0) {
          diffs.push(`# New files:\n${validUntrackedDiffs.join("\n")}`);
        }
      }

      if (hasDeletedFiles) {
        const [output, err] = this.execGit(["ls-files", "--deleted"]);

        if (err !== null) throw new Error(err);
        const { stdout: deletedFiles } = output;

        const deletedDiff = await Promise.all(
          deletedFiles
            .split("\n")
            .filter(file => file.trim())
            .map(file => {
              try {
                const [output, err] = this.execGit(["show", `HEAD:${file}`]);

                if (err !== null) throw new Error(err);
                const { stdout: oldContent } = output;

                return `diff --git a/${file} b/${file}\ndeleted file mode 100644\n--- a/${file}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${oldContent.trim()}\n`;
              } catch {
                return "";
              }
            })
        );
        const validDeletedDiffs = deletedDiff.filter(diff => diff.trim());
        if (validDeletedDiffs.length > 0) {
          diffs.push(`# Deleted files:\n${validDeletedDiffs.join("\n")}`);
        }
      }

      const combinedDiff = diffs.join("\n\n").trim();
      if (!combinedDiff) {
        throw new NoChangesDetectedError("No changes detected.");
      }

      return combinedDiff;
    } catch (error) {
      void logError(`Failed to get diff: ${(error as Error).message}`);
      throw new Error(`Failed to get diff: ${(error as Error).message}`);
    }
  }
  static getChangedFiles(onlyStaged = false): string[] {
    try {
      const [output, err] = this.execGit(["status", "--porcelain"]);

      if (err !== null) throw new Error(err);

      return output.stdout
        .split("\n")
        .filter(line => line.trim() !== "")
        .filter(line => {
          if (line.includes("Subproject commit") || line.includes("Entering")) {
            return false;
          }

          if (onlyStaged) {
            // For staged changes, check first character
            return STAGED_STATUS_CODES.includes(line[0] as GitStatusCode);
          }
          // For all changes, check both staged and unstaged status
          const [staged, unstaged] = [line[0], line[1]];
          return staged !== " " || unstaged !== " ";
        })
        .map(line => {
          const status = line.substring(0, 2);
          let filePath = line.trim().substring(2).trim();

          // Handle renamed files (they have format "R100 old-name -> new-name")
          if (status.startsWith("R")) {
            filePath = filePath.split(" -> ")[1];
          }

          // Log file status for debugging
          // void console.log(`File ${filePath} has status: ${status}`);

          // Return relative path as git status returns it
          return filePath;
        });
    } catch (error) {
      void console.error("Error getting changed files:", error as Error);
      return [];
    }
  }
  static isNewFile(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath.replace(/^\/+/, ""));
    const [output, err] = this.execGit([
      "status",
      "--porcelain",
      normalizedPath,
    ]);

    if (err !== null) throw new Error(err);

    const { stdout } = output;

    const status = stdout.slice(0, 2);
    return status === "??" || status === "A ";
  }
  static isFileDeleted(filePath: string): boolean {
    const normalizedPath = path.normalize(filePath.replace(/^\/+/, ""));
    const [output, err] = this.execGit([
      "status",
      "--porcelain",
      normalizedPath,
    ]);

    if (err !== null) throw new Error(err);

    const { stdout } = output;

    const status = stdout.slice(0, 2);
    return status === " D" || status === "D ";
  }
  static isGitRepo(): boolean {
    const [output, err] = CommandService.execute("git", [
      "rev-parse",
      "--is-inside-work-tree",
    ]);

    if (err !== null) return false;
    const { stdout, stderr, code } = output;

    if (code !== 0) return false;
    if (stderr) return false;

    return stdout.startsWith("true");
  }
  static getRepoPath(): Result<string> {
    if (!this.isGitRepo()) return [null, "Directory is not a git repo"];

    const [output, err] = this.execGit(["rev-parse", "--show-toplevel"]);

    if (err !== null || output.stderr || output.code !== 0) {
      return [null, "Unable to determine the Git repository root directory."];
    }

    return [output.stdout, null];
  }
  static setRepoPath(value: string) {
    this.repoPath = value;
  }
}

export default GitService;
